import { Interval } from './interval.mjs'
import { nextId } from './state.mjs'
import { DeskError, ERRORS, fail } from './errors.mjs'
// 分项在取数台账上的生命周期状态。
export const ITEM_STATUS = Object.freeze({
  PENDING: 'pending', // 尚未成功受理，仍可能在后续班次领取
  BLOCKED: 'blocked', // 本班名额花完/窗口未开，等下一班公布额度
  ACCEPTED: 'accepted', // 站方已受理、占额，等待或已有结果
  CANCELLED: 'cancelled', // 主动取消，停止后续领取
  CLOSED: 'closed' // 已全部交付，或已无权限/不达门槛而结案
})

// 统计段的四类明确去向（题目要求逐段区分，不得用大区间相减推断）。
export const SEGMENT_STATUS = Object.freeze({
  WAITING: 'waiting', // 尚无结果
  BELOW_THRESHOLD: 'below-threshold', // 人数未达发布门槛
  NO_PERMISSION: 'no-permission', // 已无权限（许可收紧/用途不符）
  DELIVERABLE: 'deliverable', // 可发合作方
  DELIVERED: 'delivered', // 已发出
  RETIRED: 'retired', // 曾发出，后续许可收紧后停用
  CANCELLED: 'cancelled' // 随分项主动取消
})

function requireMap(map, id, label) {
  const value = map[id]
  if (!value) fail(ERRORS.NOT_FOUND, `${label}不存在：${id}`)
  return value
}

// 取数台核心。构造时传入仓储与站方网关；所有变更都走 repository.mutate，
// 网关调用在 mutate 之外先完成，避免把网络 I/O 夹在状态提交中间。
export class Desk {
  #repo
  #gateway
  #clock

  constructor(repository, gateway, options = {}) {
    this.#repo = repository
    this.#gateway = gateway
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  #now() {
    return this.#clock()
  }

  // ---------- 站点与班次额度 ----------

  async registerSite({ stationId, name = stationId, threshold = 5 }) {
    return this.#repo.mutate(state => {
      if (state.sites[stationId]) fail(ERRORS.DUPLICATE_KEY, `站点已登记：${stationId}`)
      state.sites[stationId] = { id: stationId, name, threshold }
      return state.sites[stationId]
    })
  }

  // 公布新班次额度。只有站方公布之后，上一班被挡住的申请才允许重新尝试。
  async openShift({ stationId, shift, limit }) {
    return this.#repo.mutate(state => {
      requireMap(state.sites, stationId, '站点')
      const windows = (state.shifts[stationId] ??= [])
      if (windows.some(w => w.shift === shift)) {
        fail(ERRORS.DUPLICATE_KEY, `站点 ${stationId} 的班次 ${shift} 已公布`)
      }
      windows.push({ shift, limit: Number(limit), openedAt: this.#now() })
      return windows.at(-1)
    })
  }

  async siteLedger(stationId) {
    const state = await this.#repo.read()
    requireMap(state.sites, stationId, '站点')
    return this.#buildSiteLedger(state, stationId)
  }

  #buildSiteLedger(state, stationId) {
    const site = state.sites[stationId]
    const windows = (state.shifts[stationId] ?? []).map(w => ({ ...w, used: 0, acceptanceNos: [], blocked: [] }))
    const windowByKey = new Map(windows.map(w => [`${stationId}/${w.shift}`, w]))
    // 占额以受理号为准：无论受理是本地发起还是资料流补登，一次受理占一个名额，
    // 未达门槛或撤销都不释放。
    for (const acceptance of Object.values(state.acceptances)) {
      if (acceptance.station !== stationId) continue
      const w = windowByKey.get(`${stationId}/${acceptance.shift}`)
      if (w) {
        w.used += 1
        w.acceptanceNos.push(acceptance.acceptanceNo)
      }
    }
    // 未发申请单独分栏：被窗口/额度挡住、且没有产生受理号的发起记录。
    for (const submission of Object.values(state.submissions)) {
      if (submission.station !== stationId || submission.acceptanceNo) continue
      if (submission.outcome === 'window-not-open' || submission.outcome === 'quota-exhausted') {
        const w = windowByKey.get(`${stationId}/${submission.shift}`)
        if (w) w.blocked.push({ itemId: submission.itemId, key: submission.key, outcome: submission.outcome })
      }
    }
    return {
      station: { id: site.id, name: site.name, threshold: site.threshold },
      windows: windows.map(w => ({
        shift: w.shift,
        limit: w.limit,
        used: w.used,
        remaining: Math.max(0, w.limit - w.used),
        acceptanceNos: w.acceptanceNos,
        blocked: w.blocked
      }))
    }
  }

  // ---------- 合作方请求与分项 ----------

  async createRequest({ requestId, partner, purpose, items, renewedFrom = null }) {
    return this.#repo.mutate(state => {
      if (state.requests[requestId]) fail(ERRORS.DUPLICATE_KEY, `请求编号已存在：${requestId}`)
      if (renewedFrom && !state.requests[renewedFrom]) {
        fail(ERRORS.NOT_FOUND, `续办来源请求不存在：${renewedFrom}`)
      }
      const itemList = items.map(raw => {
        const stationId = String(raw.station)
        requireMap(state.sites, stationId, '站点')
        const interval = Interval.from(raw.interval)
        const item = {
          id: nextId(state, 'I'),
          station: stationId,
          metric: raw.metric ?? 'count',
          interval: interval.toJSON(),
          purpose: String(raw.purpose ?? purpose),
          partner: String(partner),
          requestId,
          status: ITEM_STATUS.PENDING,
          blockedSince: null,
          acceptanceNo: null,
          createdAt: this.#now()
        }
        state.items[item.id] = item
        return item
      })
      state.requests[requestId] = {
        id: requestId,
        partner: String(partner),
        purpose: String(purpose),
        itemIds: itemList.map(i => i.id),
        renewedFrom,
        createdAt: this.#now()
      }
      state.requestIndex.push(requestId)
      return state.requests[requestId]
    })
  }

  // 按申请续办：复制分项到新请求，额度去向仍可沿旧请求的受理号追溯。
  async renewRequest({ fromRequestId, newRequestId, partner, purpose, items }) {
    const state = await this.#repo.read()
    requireMap(state.requests, fromRequestId, '请求')
    return this.createRequest({ requestId: newRequestId, partner, purpose, items, renewedFrom: fromRequestId })
  }

  // ---------- 发起受理（含断线核对、额度门控） ----------

  // 生成「原请求键」。键绑定 站点+班次+分项，断线重连必须复用同一个键。
  #requestKey(state, item, shift) {
    return `desk-${item.requestId}-${item.id}-${item.station}-${shift}`
  }

  #shiftOf(state, stationId, shift) {
    return (state.shifts[stationId] ?? []).find(w => w.shift === shift)
  }

  async submitItem({ itemId, shift, requestKey = null }) {
    const state = await this.#repo.read()
    const item = requireMap(state.items, itemId, '分项')
    if (item.status === ITEM_STATUS.CANCELLED) fail(ERRORS.ITEM_CANCELLED, '分项已主动取消，不能再发起')
    if (item.status === ITEM_STATUS.CLOSED) fail(ERRORS.ITEM_CANCELLED, '分项已结案，不能再发起')
    if (item.acceptanceNo) fail(ERRORS.ALREADY_ACCEPTED, '分项已有受理号，不能重复发起')

    // 默认键由台账确定性生成，保证断线重连一定复用；
    // 对接演练来源时允许显式指定来源侧已知的客户请求键。
    const key = requestKey ?? this.#requestKey(state, item, shift)
    const existing = state.keyIndex[key]
    if (existing) {
      // 原请求键只能回到同一条发起记录上，不允许换内容复用。
      const before = state.submissions[existing]
      if (before.itemId !== itemId) fail(ERRORS.KEY_MISMATCH, '请求键已被其他分项占用')
      if (before.outcome === 'accepted' || before.outcome === 'disconnected' || before.outcome === 'pending') {
        return { reused: true, submission: before }
      }
      // 窗口未开/额度耗尽/确证未受理：站方公布新额度或工作单后允许同键重试，
      // 继续往下走门控与网关调用，记录在同一条发起上留痕。
    }

    // 本地只门控「班次是否公布」：未公布绝不发起，留痕说明卡点。
    // 额度是否耗尽由站方写入口权威裁决（429），因为别的渠道也可能占额，
    // 本地站账未必完整；站方答复后同样留痕进「未发申请」分栏。
    const window = this.#shiftOf(state, item.station, shift)
    if (!window) {
      return { reused: false, submission: await this.#recordBlocked(item, shift, key, ERRORS.WINDOW_NOT_OPEN) }
    }

    const outcome = await this.#gateway.postRequest({ key })
    return { reused: false, submission: await this.#applyGatewayOutcome(item, shift, key, outcome) }
  }

  async #recordBlocked(item, shift, key, code) {
    return this.#repo.mutate(state => {
      const fresh = state.items[item.id]
      const submission = {
        id: nextId(state, 'Q'),
        key,
        itemId: fresh.id,
        requestId: fresh.requestId,
        station: fresh.station,
        shift,
        outcome: code === ERRORS.QUOTA_EXHAUSTED ? 'quota-exhausted' : 'window-not-open',
        attempts: 1,
        acceptanceNo: null,
        at: this.#now()
      }
      state.submissions[submission.id] = submission
      state.keyIndex[key] = submission.id
      fresh.status = ITEM_STATUS.BLOCKED
      fresh.blockedSince = { shift, reason: submission.outcome, at: submission.at }
      return submission
    })
  }

  async #applyGatewayOutcome(item, shift, key, outcome) {
    return this.#repo.mutate(state => {
      const fresh = state.items[item.id]
      const existingId = state.keyIndex[key]
      const submission = existingId
        ? state.submissions[existingId]
        : {
            id: nextId(state, 'Q'),
            key,
            itemId: fresh.id,
            requestId: fresh.requestId,
            station: fresh.station,
            shift,
            outcome: 'initiated',
            attempts: 0,
            acceptanceNo: null,
            at: this.#now()
          }
      submission.attempts += 1
      submission.at = this.#now()

      if (outcome.outcome === 'received') {
        return this.#markAccepted(state, submission, fresh, shift, outcome.receipt)
      }
      if (outcome.outcome === 'disconnected') {
        submission.outcome = 'disconnected'
        state.submissions[submission.id] = submission
        state.keyIndex[key] = submission.id
        fresh.status = ITEM_STATUS.PENDING
        return submission
      }
      if (outcome.outcome === 'pending') {
        submission.outcome = 'pending'
        state.submissions[submission.id] = submission
        state.keyIndex[key] = submission.id
        return submission
      }
      if (outcome.outcome === 'window-not-open' || outcome.outcome === 'quota-exhausted') {
        submission.outcome = outcome.outcome
        state.submissions[submission.id] = submission
        state.keyIndex[key] = submission.id
        fresh.status = ITEM_STATUS.BLOCKED
        fresh.blockedSince = { shift, reason: outcome.outcome, at: submission.at }
        return submission
      }
      if (outcome.outcome === 'unknown') {
        submission.outcome = 'unknown'
        state.submissions[submission.id] = submission
        state.keyIndex[key] = submission.id
        return submission
      }
      throw new DeskError(ERRORS.UNKNOWN_REMOTE, `站方返回了无法识别的结果：${outcome.outcome}`)
    })
  }

  #markAccepted(state, submission, item, shift, receipt) {
    const acceptanceNo = receipt.acceptanceNo
    let acceptance = state.acceptances[acceptanceNo]
    if (!acceptance) {
      acceptance = {
        acceptanceNo,
        station: item.station,
        shift,
        permitRef: receipt.permitRef ?? null,
        remoteStatus: receipt.remoteStatus ?? 'accepted',
        itemIds: [],
        segmentIds: [],
        confirmedAt: this.#now()
      }
      state.acceptances[acceptanceNo] = acceptance
    }
    if (!acceptance.itemIds.includes(item.id)) acceptance.itemIds.push(item.id)
    submission.outcome = 'accepted'
    submission.acceptanceNo = acceptanceNo
    state.submissions[submission.id] = submission
    state.keyIndex[submission.key] = submission.id
    item.status = ITEM_STATUS.ACCEPTED
    item.acceptanceNo = acceptanceNo
    item.blockedSince = null
    return submission
  }

  // 响应断开后的唯一正确动作：拿原请求键到站方核对，禁止换新键重发。
  async confirmSubmission({ submissionId }) {
    const state = await this.#repo.read()
    const submission = requireMap(state.submissions, submissionId, '发起记录')
    if (submission.outcome === 'accepted') return { reused: true, submission }
    const outcome = await this.#gateway.confirmRequest({ key: submission.key })
    return this.#repo.mutate(latest => {
      const sub = latest.submissions[submissionId]
      const item = latest.items[sub.itemId]
      sub.attempts += 1
      sub.at = this.#now()
      if (outcome.outcome === 'received') {
        this.#markAccepted(latest, sub, item, sub.shift, outcome.receipt)
        return { reused: false, submission: sub }
      }
      if (outcome.outcome === 'pending') {
        sub.outcome = 'pending'
        return { reused: false, submission: sub }
      }
      if (outcome.outcome === 'unknown') {
        // 确证未受理：清除键占用，下一次可用同一个键再次发起。
        sub.outcome = 'unknown'
        return { reused: false, submission: sub, mayResubmit: true }
      }
      throw new DeskError(ERRORS.UNKNOWN_REMOTE, `核对返回了无法识别的结果：${outcome.outcome}`)
    })
  }

  get repo() {
    return this.#repo
  }

  // 对账用：受理号已在本地确认，但许可/段信息来自外部资料流，补登到既有受理上。
  async attachPermissionToAcceptance({ acceptanceNo, segments }) {
    return this.#repo.mutate(state => {
      const acceptance = requireMap(state.acceptances, acceptanceNo, '受理号')
      const version = this.#latestVersion(state, acceptance) + 1
      const newIds = []
      for (const raw of segments) {
        const item = requireMap(state.items, raw.itemId, '分项')
        if (item.station !== acceptance.station) fail(ERRORS.NO_PERMISSION, '受理站点与分项站点不一致')
        if (!acceptance.itemIds.includes(item.id)) acceptance.itemIds.push(item.id)
        const seg = {
          id: nextId(state, 'G'),
          acceptanceNo,
          itemId: item.id,
          station: acceptance.station,
          metric: raw.metric ?? item.metric,
          interval: Interval.from(raw.interval).toJSON(),
          purpose: String(raw.purpose ?? item.purpose),
          version,
          result: null,
          deliveryId: null,
          status: SEGMENT_STATUS.WAITING,
          createdAt: this.#now()
        }
        state.segments[seg.id] = seg
        acceptance.segmentIds.push(seg.id)
        newIds.push(seg.id)
        if (!item.acceptanceNo) {
          item.acceptanceNo = acceptanceNo
          item.status = ITEM_STATUS.ACCEPTED
          item.blockedSince = null
        }
        this.#reclassifySegment(state, seg)
      }
      this.#reassessUnderLatestPermission(state, acceptance, version)
      return { acceptanceNo, version, segmentIds: newIds }
    })
  }

  // 对账入口：外部来源（模拟器）已经确认的受理，直接补登台账，
  // 不占本地班次额度以外的任何东西——受理事实本就发生在站方。
  async attachRemoteAcceptance({ acceptanceNo, station, shift = null, permitRef = null, segments }) {
    return this.#repo.mutate(state => {
      if (state.acceptances[acceptanceNo]) {
        fail(ERRORS.DUPLICATE_KEY, `受理号已登记：${acceptanceNo}`)
      }
      const acceptance = {
        acceptanceNo,
        station,
        shift,
        permitRef,
        remoteStatus: 'accepted',
        itemIds: [],
        segmentIds: [],
        confirmedAt: this.#now()
      }
      state.acceptances[acceptanceNo] = acceptance
      const created = []
      for (const raw of segments) {
        const item = requireMap(state.items, raw.itemId, '分项')
        if (item.station !== station) fail(ERRORS.NO_PERMISSION, '受理站点与分项站点不一致')
        if (!acceptance.itemIds.includes(item.id)) acceptance.itemIds.push(item.id)
        const seg = {
          id: nextId(state, 'G'),
          acceptanceNo,
          itemId: item.id,
          station,
          metric: raw.metric ?? item.metric,
          interval: Interval.from(raw.interval).toJSON(),
          purpose: String(raw.purpose ?? item.purpose),
          version: 1,
          result: null,
          deliveryId: null,
          status: SEGMENT_STATUS.WAITING,
          createdAt: this.#now()
        }
        state.segments[seg.id] = seg
        acceptance.segmentIds.push(seg.id)
        created.push(seg.id)
        item.acceptanceNo = acceptanceNo
        item.status = ITEM_STATUS.ACCEPTED
        item.blockedSince = null
        this.#reclassifySegment(state, seg)
      }
      return { acceptanceNo, version: 1, segmentIds: created }
    })
  }

  // ---------- 许可版本与统计段 ----------

  // 登记一版许可。同一受理号可回若干独立批准的统计段；
  // 许可可以缩短区间、只批一部分项，也可以把用途限死。
  async recordPermission({ acceptanceNo, segments }) {
    return this.#repo.mutate(state => {
      const acceptance = requireMap(state.acceptances, acceptanceNo, '受理号')
      const version = (acceptance.segmentIds.reduce((max, sid) => {
        const seg = state.segments[sid]
        return Math.max(max, seg.version)
      }, 0)) + 1

      const newIds = []
      for (const raw of segments) {
        const interval = Interval.from(raw.interval)
        const item = state.items[raw.itemId]
        if (!item || !acceptance.itemIds.includes(raw.itemId)) {
          fail(ERRORS.NOT_FOUND, `受理号 ${acceptanceNo} 下没有分项 ${raw.itemId}`)
        }
        const seg = {
          id: nextId(state, 'G'),
          acceptanceNo,
          itemId: item.id,
          station: acceptance.station,
          metric: raw.metric ?? item.metric,
          interval: interval.toJSON(),
          purpose: String(raw.purpose ?? item.purpose),
          version,
          result: null, // { from, until, headcount, resultRef, at }
          deliveryId: null,
          status: SEGMENT_STATUS.WAITING,
          createdAt: this.#now()
        }
        state.segments[seg.id] = seg
        acceptance.segmentIds.push(seg.id)
        newIds.push(seg.id)
      }

      // 旧版本段立刻重判：最新许可不再覆盖的，不能再拿去补新缺项；
      // 已经发出去的也要明确停用，但受理与占额记录保留在站账上。
      this.#reassessUnderLatestPermission(state, acceptance, version)
      for (const sid of newIds) this.#reclassifySegment(state, state.segments[sid])
      return { version, segmentIds: newIds }
    })
  }

  #latestVersion(state, acceptance) {
    return acceptance.segmentIds.reduce((max, sid) => Math.max(max, state.segments[sid].version), 0)
  }

  // 段资格重判：用途与所属分项不一致，或许可段不再落在分项区间内，
  // 即「已无权限」。交付前还会再走一次 #eligibleSegments 双保险。
  #reclassifySegment(state, seg) {
    if ([SEGMENT_STATUS.DELIVERED, SEGMENT_STATUS.RETIRED, SEGMENT_STATUS.CANCELLED, SEGMENT_STATUS.NO_PERMISSION].includes(seg.status)) {
      return
    }
    const item = state.items[seg.itemId]
    const noPermission = seg.purpose !== item.purpose ||
      !Interval.from(item.interval).intersects(Interval.from(seg.interval))
    if (noPermission) seg.status = SEGMENT_STATUS.NO_PERMISSION
  }

  #reassessUnderLatestPermission(state, acceptance, latestVersion) {
    const groups = new Map()
    for (const sid of acceptance.segmentIds) {
      const seg = state.segments[sid]
      if (!groups.has(seg.itemId)) groups.set(seg.itemId, [])
      groups.get(seg.itemId).push(seg)
    }
    for (const segmentsOfItem of groups.values()) {
      const latest = segmentsOfItem.filter(s => s.version === latestVersion)
      const old = segmentsOfItem.filter(s => s.version < latestVersion)
      const item = state.items[latest[0]?.itemId ?? old[0].itemId]
      for (const seg of old) {
        const stillCovered = latest.some(now =>
          now.purpose === seg.purpose &&
          Interval.from(now.interval).covers(Interval.from(seg.interval)))
        if (!stillCovered && seg.status !== SEGMENT_STATUS.RETIRED && seg.status !== SEGMENT_STATUS.CANCELLED) {
          if (seg.deliveryId) this.#retireDelivery(state, seg, '许可收紧，最新版不再覆盖该段')
          else if (seg.status === SEGMENT_STATUS.DELIVERABLE) seg.status = SEGMENT_STATUS.NO_PERMISSION
          else if (seg.status === SEGMENT_STATUS.WAITING || seg.status === SEGMENT_STATUS.BELOW_THRESHOLD) {
            seg.status = SEGMENT_STATUS.NO_PERMISSION
          }
        }
      }
      this.#refreshItemStatus(state, item)
    }
  }

  #retireDelivery(state, segment, reason) {
    const delivery = state.deliveries[segment.deliveryId]
    segment.status = SEGMENT_STATUS.RETIRED
    if (delivery && !state.retiredDeliveries[delivery.id]) {
      state.retiredDeliveries[delivery.id] = { at: this.#now(), reason }
      delivery.active = false
      delivery.retiredReason = reason
    }
  }

  // 站方回结果：一个受理号下可以有多段，逐段登记人数与结果编号。
  async recordResult({ segmentId, interval, headcount, resultRef }) {
    return this.#repo.mutate(state => {
      const seg = requireMap(state.segments, segmentId, '统计段')
      const acceptance = state.acceptances[seg.acceptanceNo]
      if (seg.version !== this.#latestVersion(state, acceptance)) {
        fail(ERRORS.NO_PERMISSION, '该段不属于最新许可版本，结果只能登记在新版段上')
      }
      const iv = Interval.from(interval)
      if (!Interval.from(seg.interval).covers(iv)) {
        fail(ERRORS.NO_PERMISSION, `结果区间 ${iv} 超出许可段 ${Interval.from(seg.interval)}`)
      }
      const count = Number(headcount)
      if (!Number.isInteger(count) || count < 0) fail(ERRORS.BELOW_THRESHOLD, '人数必须是非负整数')
      seg.result = {
        from: iv.from,
        until: iv.until,
        headcount: count,
        resultRef: String(resultRef),
        at: this.#now()
      }
      const threshold = state.sites[seg.station].threshold
      if (count < threshold) {
        if (seg.status === SEGMENT_STATUS.WAITING) seg.status = SEGMENT_STATUS.BELOW_THRESHOLD
      } else if (seg.status === SEGMENT_STATUS.WAITING) {
        seg.status = SEGMENT_STATUS.DELIVERABLE
      }
      this.#refreshItemStatus(state, state.items[seg.itemId])
      return seg
    })
  }

  // ---------- 主动取消 ----------

  async cancelItem({ itemId, reason = '' }) {
    return this.#repo.mutate(state => {
      const item = requireMap(state.items, itemId, '分项')
      if (item.status === ITEM_STATUS.CANCELLED) return item
      state.cancelled[itemId] = { at: this.#now(), reason }
      item.status = ITEM_STATUS.CANCELLED
      item.blockedSince = null
      // 已受理的受理号与占额保留在站账上，只是停止后续领取：
      // 尚未出结果或可发未发的段标为取消；未达门槛、已无权限等
      // 解释性状态保留，已发出的交付不回溯。
      if (item.acceptanceNo) {
        const acceptance = state.acceptances[item.acceptanceNo]
        for (const sid of acceptance.segmentIds) {
          const seg = state.segments[sid]
          if (seg.itemId !== itemId) continue
          if ([SEGMENT_STATUS.WAITING, SEGMENT_STATUS.DELIVERABLE].includes(seg.status)) {
            seg.status = SEGMENT_STATUS.CANCELLED
          }
        }
      }
      return item
    })
  }

  // ---------- 对合作方交付 ----------

  #eligibleSegments(state, item) {
    if (!item.acceptanceNo) return []
    const acceptance = state.acceptances[item.acceptanceNo]
    const latestVersion = this.#latestVersion(state, acceptance)
    return acceptance.segmentIds
      .map(sid => state.segments[sid])
      .filter(seg => seg.itemId === item.id && seg.version === latestVersion)
      .filter(seg => seg.purpose === item.purpose)
      .filter(seg => Interval.from(seg.interval).intersects(Interval.from(item.interval)))
  }

  async deliverRequest({ requestId }) {
    const state = await this.#repo.read()
    const request = requireMap(state.requests, requestId, '请求')
    const picked = []
    for (const itemId of request.itemIds) {
      const item = state.items[itemId]
      if (item.status === ITEM_STATUS.CANCELLED) continue
      for (const seg of this.#eligibleSegments(state, item)) {
        if (seg.status === SEGMENT_STATUS.DELIVERABLE && seg.result) picked.push(seg)
      }
    }
    if (picked.length === 0) fail(ERRORS.NOTHING_TO_DELIVER, '当前没有用途与最新许可均符合、且达到发布门槛的段')

    return this.#repo.mutate(latest => {
      const delivery = {
        id: nextId(latest, 'D'),
        requestId,
        partner: latest.requests[requestId].partner,
        at: this.#now(),
        active: true,
        entries: []
      }
      for (const seg of picked) {
        const live = latest.segments[seg.id]
        if (live.status !== SEGMENT_STATUS.DELIVERABLE || live.deliveryId) continue
        live.status = SEGMENT_STATUS.DELIVERED
        live.deliveryId = delivery.id
        delivery.entries.push({
          segmentId: live.id,
          itemId: live.itemId,
          station: live.station,
          interval: live.result ? { from: live.result.from, until: live.result.until } : live.interval,
          purpose: live.purpose,
          resultRef: live.result.resultRef,
          headcount: live.result.headcount,
          permitVersion: live.version
        })
        this.#refreshItemStatus(latest, latest.items[live.itemId])
      }
      if (delivery.entries.length === 0) fail(ERRORS.ALREADY_DELIVERED, '这些段均已发出，没有新的可交付内容')
      latest.deliveries[delivery.id] = delivery
      return delivery
    })
  }

  #refreshItemStatus(state, item) {
    // 主动取消是本地终局决定，站方后补结果或许可不恢复领取。
    if (item.status === ITEM_STATUS.CANCELLED) return
    if (!item.acceptanceNo) return
    const acceptance = state.acceptances[item.acceptanceNo]
    const latestVersion = this.#latestVersion(state, acceptance)
    const mine = acceptance.segmentIds.map(sid => state.segments[sid]).filter(s => s.itemId === item.id)
    if (mine.length === 0) return
    const latest = mine.filter(s => s.version === latestVersion)
    const open = latest.some(s =>
      [SEGMENT_STATUS.WAITING, SEGMENT_STATUS.DELIVERABLE].includes(s.status))
    // 结案后若站方补出新版在途段，分项回到已受理继续跟；否则保持结案。
    if (open) item.status = ITEM_STATUS.ACCEPTED
    else item.status = ITEM_STATUS.CLOSED
  }

  // ---------- 查询视图 ----------

  async requestView(requestId) {
    const state = await this.#repo.read()
    const request = requireMap(state.requests, requestId, '请求')
    return {
      request: { ...request },
      items: request.itemIds.map(itemId => this.#itemView(state, state.items[itemId])),
      deliveries: Object.values(state.deliveries)
        .filter(d => d.requestId === requestId)
        .map(d => this.#deliveryView(state, d))
    }
  }

  #itemView(state, item) {
    const submissions = Object.values(state.submissions)
      .filter(s => s.itemId === item.id)
      .sort((a, b) => a.id.localeCompare(b.id))
    let segments = []
    if (item.acceptanceNo) {
      const acceptance = state.acceptances[item.acceptanceNo]
      const latestVersion = this.#latestVersion(state, acceptance)
      segments = acceptance.segmentIds.map(sid => state.segments[sid])
        .filter(s => s.itemId === item.id)
        .map(seg => ({
          ...seg,
          interval: Interval.from(seg.interval).toJSON(),
          latest: seg.version === latestVersion,
          result: seg.result
            ? { ...seg.result, interval: { from: seg.result.from, until: seg.result.until } }
            : null
        }))
    }
    const buckets = {
      waiting: [],
      belowThreshold: [],
      cancelled: [],
      noPermission: [],
      deliverable: [],
      delivered: [],
      retired: []
    }
    for (const seg of segments) {
      if (seg.status === SEGMENT_STATUS.WAITING) buckets.waiting.push(seg.id)
      else if (seg.status === SEGMENT_STATUS.BELOW_THRESHOLD) buckets.belowThreshold.push(seg.id)
      else if (seg.status === SEGMENT_STATUS.CANCELLED) buckets.cancelled.push(seg.id)
      else if (seg.status === SEGMENT_STATUS.NO_PERMISSION) buckets.noPermission.push(seg.id)
      else if (seg.status === SEGMENT_STATUS.DELIVERABLE) buckets.deliverable.push(seg.id)
      else if (seg.status === SEGMENT_STATUS.DELIVERED) buckets.delivered.push(seg.id)
      else if (seg.status === SEGMENT_STATUS.RETIRED) buckets.retired.push(seg.id)
    }
    return {
      ...item,
      interval: Interval.from(item.interval).toJSON(),
      submissions: submissions.map(s => ({
        id: s.id, key: s.key, shift: s.shift, outcome: s.outcome,
        attempts: s.attempts, acceptanceNo: s.acceptanceNo, at: s.at
      })),
      segments,
      buckets,
      cancelRecord: state.cancelled[item.id] ?? null
    }
  }

  #deliveryView(state, delivery) {
    return {
      ...delivery,
      retirement: state.retiredDeliveries[delivery.id] ?? null
    }
  }

  // 合作方实际拿到了哪一版的哪些段（含已停用的历史交付）。
  async partnerReceipts(partner) {
    const state = await this.#repo.read()
    return Object.values(state.deliveries)
      .filter(d => d.partner === partner)
      .map(d => this.#deliveryView(state, d))
  }

  async quotaTrace(requestId) {
    const state = await this.#repo.read()
    requireMap(state.requests, requestId, '请求')
    const rows = []
    for (const itemId of state.requests[requestId].itemIds) {
      const item = state.items[itemId]
      for (const s of Object.values(state.submissions).filter(x => x.itemId === itemId)) {
        rows.push({
          itemId,
          station: s.station,
          shift: s.shift,
          key: s.key,
          outcome: s.outcome,
          attempts: s.attempts,
          acceptanceNo: s.acceptanceNo,
          at: s.at
        })
      }
    }
    return rows.sort((a, b) => a.at.localeCompare(b.at))
  }

  async listRequests() {
    const state = await this.#repo.read()
    return state.requestIndex.map(id => {
      const request = state.requests[id]
      const items = request.itemIds.map(iid => state.items[iid])
      const counts = items.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1
        return acc
      }, {})
      return { id, partner: request.partner, purpose: request.purpose, renewedFrom: request.renewedFrom, itemCount: items.length, statusCounts: counts }
    })
  }
}
