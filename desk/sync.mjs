// 把来源模拟器的资料流对账进取数台台账。
// 设计原则：模拟器是「站方事实」的外部来源，取数台是联络员的工作台账；
// 对账只按编号幂等补齐站点、班次、许可、结果、已发记录和撤销事实，
// 不替联络员发起受理，也不覆盖台账上的本地决定。
import { Desk, ITEM_STATUS, SEGMENT_STATUS } from './stateful.mjs'
import { Interval } from './interval.mjs'
import { pullStream } from './http-gateway.mjs'
import { ERRORS } from './errors.mjs'

async function streams(root, edition) {
  const params = edition ? { edition } : {}
  const names = ['requests', 'permit', 'quota', 'jobs', 'rows', 'issued', 'withdraw']
  const entries = await Promise.all(names.map(async name => [name, await pullStream(root, name, params)]))
  return Object.fromEntries(entries)
}

// 站点与班次额度：quota 流出现即视为站方已公布该额度窗。
export async function syncSites(desk, root, { edition, threshold = 5 } = {}) {
  const data = await streams(root, edition)
  const stations = [...new Set(data.quota.map(row => row[0]))]
  for (const stationId of stations) {
    try {
      await desk.registerSite({ stationId, threshold })
    } catch (error) {
      if (error.code !== ERRORS.DUPLICATE_KEY) throw error
    }
  }
  const opened = []
  for (const [stationId, shift, limit] of data.quota) {
    try {
      opened.push(await desk.openShift({ stationId, shift, limit: Number(limit) }))
    } catch (error) {
      if (error.code !== ERRORS.DUPLICATE_KEY) throw error
    }
  }
  return { stations, shiftsOpened: opened.length }
}

// 请求流 -> 取数台请求与分项。requests: 请求、合作方、站、指标、起止日、用途。
export async function syncRequests(desk, root, { edition } = {}) {
  const data = await streams(root, edition)
  const grouped = new Map()
  for (const [requestId, partner, station, metric, from, until, purpose] of data.requests) {
    if (!grouped.has(requestId)) grouped.set(requestId, { partner, purpose, items: [] })
    grouped.get(requestId).items.push({ station, metric, interval: [Number(from), Number(until)], purpose })
  }
  const created = []
  for (const [requestId, body] of grouped) {
    try {
      await desk.createRequest({ requestId, ...body })
      created.push(requestId)
    } catch (error) {
      if (error.code !== ERRORS.DUPLICATE_KEY) throw error
    }
  }
  return created
}

// 许可流 + 受理工作流 -> 受理号与许可版本（含多段许可）。
// permit: 编号、请求、站、指标、起止日、适用用途、状态
// jobs:   客户请求键、站、额度窗、受理号、审批号、状态
export async function syncPermissions(desk, root, { edition } = {}) {
  const data = await streams(root, edition)
  const state = await desk.repo.read()
  const result = []

  const segmentsForPermit = permitRef => {
    const segments = []
    for (const row of data.permit.filter(p => p[0] === permitRef)) {
      const [, requestId, station, metric, from, until, purpose] = row
      const item = findItem(state, requestId, station, [Number(from), Number(until)])
      if (item) segments.push({ itemId: item.id, interval: [Number(from), Number(until)], purpose, metric })
    }
    return segments
  }

  const attach = async (acceptanceNo, station, permitRefs) => {
    const segments = [...new Set(permitRefs)].flatMap(ref => segmentsForPermit(ref))
    if (segments.length === 0) return
    try {
      result.push(await desk.attachRemoteAcceptance({ acceptanceNo, station, shift: byAcceptance.get(acceptanceNo)?.shift ?? null, segments }))
    } catch (error) {
      if (error.code !== ERRORS.DUPLICATE_KEY) throw error
      // 受理号已在本地（例如断线核对后确认）：资料流补登新一版许可段，
      // 但若该受理下已有同版同范围的段则保持幂等。
      const live = await desk.repo.read()
      const acceptance = live.acceptances[acceptanceNo]
      const already = acceptance.segmentIds.some(sid => {
        const seg = live.segments[sid]
        return segments.some(input =>
          seg.itemId === input.itemId &&
          seg.purpose === input.purpose &&
          Interval.from(seg.interval).equals(Interval.from(input.interval)))
      })
      if (!already) result.push(await desk.attachPermissionToAcceptance({ acceptanceNo, segments }))
    }
  }

  // 按受理号聚合：一个受理号可对应多个许可编号/统计段。
  const byAcceptance = new Map()
  for (const job of data.jobs) {
    const [clientKey, station, shift, acceptanceNo, permitRef] = job
    if (!byAcceptance.has(acceptanceNo)) byAcceptance.set(acceptanceNo, { station, shift, permitRefs: [] })
    byAcceptance.get(acceptanceNo).permitRefs.push(permitRef)
  }
  for (const [acceptanceNo, info] of byAcceptance) {
    await attach(acceptanceNo, info.station, info.permitRefs)
  }

  // jobs 流只展示站方当前可见的受理；本地已确认但流里缺失的受理号，
  // 用其 permitRef 回许可流补齐，保证受理与许可不会断链。
  const knownRefs = new Set([...byAcceptance.values()].flatMap(i => i.permitRefs))
  for (const acceptance of Object.values(state.acceptances)) {
    if (byAcceptance.has(acceptance.acceptanceNo) || !acceptance.permitRef) continue
    if (knownRefs.has(acceptance.permitRef)) continue
    await attach(acceptance.acceptanceNo, acceptance.station, [acceptance.permitRef])
  }
  return result
}

// 许可可能缩短区间或只批一部分项，因此分项匹配不能要求区间严格相等：
// 同请求、同站、同指标且与许可区间相交的分项即归属该许可。
function findItem(state, requestId, station, interval) {
  const request = state.requests[requestId]
  if (!request) return null
  const iv = Interval.from(interval)
  return request.itemIds
    .map(id => state.items[id])
    .find(item =>
      item.station === station &&
      Interval.from(item.interval).intersects(iv)) ?? null
}

// 结果流：rows: 受理号、统计起止、人数、结果编号
export async function syncResults(desk, root, { edition, threshold } = {}) {
  const data = await streams(root, edition)
  const state = await desk.repo.read()
  const done = []
  for (const [acceptanceNo, from, until, headcount, resultRef] of data.rows) {
    const acceptance = state.acceptances[acceptanceNo]
    if (!acceptance) continue
    const latestVersion = Math.max(...acceptance.segmentIds.map(sid => state.segments[sid].version))
    const segment = acceptance.segmentIds
      .map(sid => state.segments[sid])
      .filter(s => s.version === latestVersion)
      .find(s => Interval.from(s.interval).covers(Interval.from([Number(from), Number(until)])))
    if (!segment || (segment.result && segment.result.resultRef === resultRef)) continue
    await desk.recordResult({
      segmentId: segment.id,
      interval: [Number(from), Number(until)],
      headcount: Number(headcount),
      resultRef
    })
    done.push({ acceptanceNo, resultRef, headcount: Number(headcount) })
  }
  return done
}

// 站方已发记录与撤销事实（issued / withdraw 流）。
export async function syncStationFacts(desk, root, { edition } = {}) {
  const data = await streams(root, edition)
  const state = await desk.repo.read()
  const withdrawals = []
  for (const [requestId, station, metric, action] of data.withdraw) {
    const request = state.requests[requestId]
    if (!request) continue
    for (const itemId of request.itemIds) {
      const item = state.items[itemId]
      if (item.station !== station || item.metric !== metric) continue
      if (item.status === ITEM_STATUS.CANCELLED) continue
      await desk.cancelItem({ itemId, reason: `站方撤销事实：${action}` })
      withdrawals.push(itemId)
    }
  }
  const issued = []
  for (const [requestId, station, acceptanceNo, resultRef] of data.issued) {
    const request = state.requests[requestId]
    const acceptance = state.acceptances[acceptanceNo]
    if (!request || !acceptance) continue
    const segment = acceptance.segmentIds
      .map(sid => state.segments[sid])
      .find(s => s.result?.resultRef === resultRef)
    if (!segment) continue
    if (segment.status === SEGMENT_STATUS.DELIVERED) {
      issued.push({ requestId, station, resultRef, deliveryId: segment.deliveryId })
    } else if (segment.status === SEGMENT_STATUS.DELIVERABLE) {
      // 站方侧已经发出而台账未发：补登交付单，保证合作方回执完整。
      const delivery = await desk.deliverRequest({ requestId })
      issued.push({ requestId, station, resultRef, deliveryId: delivery.id, source: 'station-issued' })
    }
  }
  return { withdrawals, issued }
}

export async function syncAll(desk, root, options = {}) {
  return {
    sites: await syncSites(desk, root, options),
    requests: await syncRequests(desk, root, options),
    permissions: await syncPermissions(desk, root, options),
    results: await syncResults(desk, root, options),
    facts: await syncStationFacts(desk, root, options)
  }
}

// 只对账受理事实（jobs 流），不触碰撤销/已发等会改变本地决定的资料流。
// 用于领取前刷新站账，确保本地门控能看到站方侧已经占掉的名额。
export async function syncJobs(desk, root, { edition } = {}) {
  const data = await streams(root, edition)
  const state = await desk.repo.read()
  const known = new Set(Object.keys(state.acceptances))
  const fresh = []
  for (const [, station, shift, acceptanceNo, permitRef] of data.jobs) {
    if (known.has(acceptanceNo)) continue
    const permitRows = data.permit.filter(p => p[0] === permitRef)
    const segments = []
    for (const [, requestId, st, metric, from, until, purpose] of permitRows) {
      const item = findItem(state, requestId, st, [Number(from), Number(until)])
      if (item) segments.push({ itemId: item.id, interval: [Number(from), Number(until)], purpose, metric })
    }
    if (segments.length) {
      fresh.push(await desk.attachRemoteAcceptance({ acceptanceNo, station, shift, permitRef, segments }))
    } else {
      // 许可流暂时对不上分项：先登记受理占额，许可段后续由 syncPermissions 补。
      fresh.push(await desk.attachRemoteAcceptance({ acceptanceNo, station, shift, permitRef, segments: [] }))
    }
  }
  return fresh
}
