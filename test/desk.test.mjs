import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRepository } from '../desk/repository.mjs'
import { ScriptedGateway } from '../desk/gateway.mjs'
import { Desk, ITEM_STATUS, SEGMENT_STATUS } from '../desk/stateful.mjs'
import { Interval } from '../desk/interval.mjs'
import { ERRORS } from '../desk/errors.mjs'

let tick = 0
function makeDesk(gateway) {
  return new Desk(new MemoryRepository(), gateway, { clock: () => `t${++tick}` })
}

async function seed(desk, windows = { A: { day1: 1 }, B: { day1: 2 } }) {
  await desk.registerSite({ stationId: 'A', threshold: 5 })
  await desk.registerSite({ stationId: 'B', threshold: 5 })
  for (const [station, shifts] of Object.entries(windows)) {
    for (const [shift, limit] of Object.entries(shifts)) {
      await desk.openShift({ stationId: station, shift, limit })
    }
  }
  const request = await desk.createRequest({
    requestId: 'R1', partner: 'member', purpose: 'planning',
    items: [
      { station: 'A', metric: 'count', interval: [1, 5], purpose: 'planning' },
      { station: 'B', metric: 'count', interval: [1, 5], purpose: 'planning' }
    ]
  })
  return request.itemIds
}

test('受理一次即占班次额度，未达门槛也不释放', async () => {
  const gateway = new ScriptedGateway({
    windows: { A: { day1: 1 } },
    jobs: [{ key: 'desk-R1-I1-A-day1', station: 'A', shift: 'day1', acceptanceNo: 'j1', permitRef: 'PA' }]
  })
  const desk = makeDesk(gateway)
  const [itemA] = await seed(desk, { A: { day1: 1 } })
  const sub = await desk.submitItem({ itemId: itemA, shift: 'day1' })
  assert.equal(sub.submission.outcome, 'accepted')

  await desk.recordPermission({ acceptanceNo: 'j1', segments: [{ itemId: itemA, interval: [1, 5], purpose: 'planning' }] })
  await desk.recordResult({ segmentId: (await desk.requestView('R1')).items[0].segments[0].id, interval: [1, 5], headcount: 3, resultRef: 'z1' })

  const ledger = await desk.siteLedger('A')
  assert.equal(ledger.windows[0].used, 1)
  assert.equal(ledger.windows[0].remaining, 0)
  const view = await desk.requestView('R1')
  assert.equal(view.items[0].segments[0].status, SEGMENT_STATUS.BELOW_THRESHOLD)
  assert.equal(view.items[0].status, ITEM_STATUS.CLOSED)
  // 第二个分项在同站同班次已无法领取，但已受理的占额仍留在站账上
  const second = await desk.createRequest({
    requestId: 'R2', partner: 'member', purpose: 'planning',
    items: [{ station: 'A', metric: 'count', interval: [2, 3], purpose: 'planning' }]
  })
  const blockedItemId = second.itemIds[0]
  gateway.jobs.set(`desk-R2-${blockedItemId}-A-day1`, {
    key: `desk-R2-${blockedItemId}-A-day1`, station: 'A', shift: 'day1', acceptanceNo: 'j8', permitRef: 'PH'
  })
  const blocked = await desk.submitItem({ itemId: blockedItemId, shift: 'day1' })
  assert.equal(blocked.submission.outcome, 'quota-exhausted')
  assert.equal((await desk.requestView('R2')).items[0].status, ITEM_STATUS.BLOCKED)
  assert.equal((await desk.siteLedger('A')).windows[0].used, 1)
})

test('断线后先用原请求键核对：站方已受理则补登，不重复占额', async () => {
  const gateway = new ScriptedGateway({
    windows: { A: { day1: 1 } },
    jobs: [{ key: 'desk-R1-I1-A-day1', station: 'A', shift: 'day1', acceptanceNo: 'j1', permitRef: 'PA' }],
    ackLost: ['desk-R1-I1-A-day1']
  })
  const desk = makeDesk(gateway)
  const [itemA] = await seed(desk, { A: { day1: 1 } })
  const first = await desk.submitItem({ itemId: itemA, shift: 'day1' })
  assert.equal(first.submission.outcome, 'disconnected')
  assert.equal(gateway.postLog.length, 1)

  // 再次提交不能换新发起，只能回到断线的那条记录
  const again = await desk.submitItem({ itemId: itemA, shift: 'day1' })
  assert.equal(again.reused, true)
  assert.equal(gateway.postLog.length, 1)

  const confirmed = await desk.confirmSubmission({ submissionId: first.submission.id })
  assert.equal(confirmed.submission.outcome, 'accepted')
  assert.equal(confirmed.submission.acceptanceNo, 'j1')
  assert.equal((await desk.siteLedger('A')).windows[0].used, 1)
  assert.equal(gateway.accepted.size, 1)
})

test('核对确证未受理后，才允许用原键再次发起', async () => {
  const gateway = new ScriptedGateway({ windows: { A: { day1: 1 } }, jobs: [] })
  const desk = makeDesk(gateway)
  const [itemA] = await seed(desk, { A: { day1: 1 } })
  const first = await desk.submitItem({ itemId: itemA, shift: 'day1' })
  assert.equal(first.submission.outcome, 'unknown')
  const checked = await desk.confirmSubmission({ submissionId: first.submission.id })
  assert.equal(checked.mayResubmit, true)
  // 现在登记站方工作单，同键重发成功
  gateway.jobs.set('desk-R1-I1-A-day1', { key: 'desk-R1-I1-A-day1', station: 'A', shift: 'day1', acceptanceNo: 'j9', permitRef: 'PX' })
  const retry = await desk.submitItem({ itemId: itemA, shift: 'day1' })
  assert.equal(retry.submission.outcome, 'accepted')
  assert.equal(retry.submission.acceptanceNo, 'j9')
})

test('站方状态未明确时禁止换键，持续核对到明确为止', async () => {
  const key = 'desk-R1-I1-A-day1'
  const gateway = new ScriptedGateway({
    windows: { A: { day1: 1 } },
    jobs: [{ key, station: 'A', shift: 'day1', acceptanceNo: 'j1', permitRef: 'PA' }],
    ackLost: [key], // 受理已占额、回执丢失
    pending: [key] // 第一次核对仍未明确
  })
  const desk = makeDesk(gateway)
  const [itemA] = await seed(desk, { A: { day1: 1 } })
  const first = await desk.submitItem({ itemId: itemA, shift: 'day1' })
  assert.equal(first.submission.outcome, 'disconnected')
  const pending = await desk.confirmSubmission({ submissionId: first.submission.id })
  assert.equal(pending.submission.outcome, 'pending')
  const settled = await desk.confirmSubmission({ submissionId: first.submission.id })
  assert.equal(settled.submission.outcome, 'accepted')
  assert.equal(gateway.postLog.length, 1) // 全程没有第二次 POST
})

test('窗口未开放必须等下一班公布额度，公布后可重新尝试', async () => {
  const gateway = new ScriptedGateway({
    windows: {},
    jobs: [{ key: 'desk-R1-I1-A-day2', station: 'A', shift: 'day2', acceptanceNo: 'j4', permitRef: 'PC' }]
  })
  const desk = makeDesk(gateway)
  const [itemA] = await seed(desk, { A: { day1: 1 } })
  const blocked = await desk.submitItem({ itemId: itemA, shift: 'day2' })
  assert.equal(blocked.submission.outcome, 'window-not-open')
  assert.equal((await desk.requestView('R1')).items[0].status, ITEM_STATUS.BLOCKED)
  await desk.openShift({ stationId: 'A', shift: 'day2', limit: 1 })
  gateway.windows.A = { day2: 1 }
  const ok = await desk.submitItem({ itemId: itemA, shift: 'day2' })
  assert.equal(ok.submission.outcome, 'accepted')
})

test('一个受理号回多个独立统计段，仅达门槛且用途许可相符的段可交付', async () => {
  const gateway = new ScriptedGateway({
    windows: { B: { day1: 2 } },
    jobs: [{ key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j3', permitRef: 'PB' }]
  })
  const desk = makeDesk(gateway)
  const [, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemB, shift: 'day1' })
  const { segmentIds } = await desk.recordPermission({
    acceptanceNo: 'j3',
    segments: [
      { itemId: itemB, interval: [2, 4], purpose: 'planning' },
      { itemId: itemB, interval: [4, 5], purpose: 'planning' }
    ]
  })
  await desk.recordResult({ segmentId: segmentIds[0], interval: [2, 4], headcount: 12, resultRef: 'z3' })
  await desk.recordResult({ segmentId: segmentIds[1], interval: [4, 5], headcount: 4, resultRef: 'z4' })
  const delivery = await desk.deliverRequest({ requestId: 'R1' })
  assert.equal(delivery.entries.length, 1)
  assert.equal(delivery.entries[0].resultRef, 'z3')
  const view = await desk.requestView('R1')
  const segView = view.items[1].segments
  assert.deepEqual(segView.map(s => s.status).sort(), [SEGMENT_STATUS.BELOW_THRESHOLD, SEGMENT_STATUS.DELIVERED].sort())
})

test('四类缺项去向明确区分，不存在区间相减推断', async () => {
  const gateway = new ScriptedGateway({
    windows: { B: { day1: 2 } },
    jobs: [{ key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j3', permitRef: 'PB' }]
  })
  const desk = makeDesk(gateway)
  const [, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemB, shift: 'day1' })
  const { segmentIds } = await desk.recordPermission({
    acceptanceNo: 'j3',
    segments: [
      { itemId: itemB, interval: [1, 2], purpose: 'planning' },
      { itemId: itemB, interval: [2, 3], purpose: 'planning' },
      { itemId: itemB, interval: [3, 4], purpose: 'training' }
    ]
  })
  await desk.recordResult({ segmentId: segmentIds[1], interval: [2, 3], headcount: 2, resultRef: 'zx' })
  const before = await desk.requestView('R1')
  assert.equal(before.items[1].buckets.waiting.length, 1) // 尚无结果
  assert.equal(before.items[1].buckets.belowThreshold.length, 1) // 人数未达门槛
  assert.equal(before.items[1].buckets.noPermission.length, 1) // 用途不符已无权限
  await desk.cancelItem({ itemId: itemB, reason: '联络员局部取消' })
  const view = await desk.requestView('R1')
  const buckets = view.items[1].buckets
  assert.equal(buckets.waiting.length, 0)
  assert.equal(buckets.cancelled.length, 1) // 主动取消：等待中的段停止领取
  assert.equal(buckets.belowThreshold.length, 1) // 未达门槛的解释保留
  assert.equal(buckets.noPermission.length, 1) // 无权限的解释保留
  // 区间工具本身就没有相减运算
  assert.equal(typeof Interval.prototype.subtract, 'undefined')
})

test('许可收紧：停用原交付、保留仍被覆盖的段，并禁止旧材料补新缺项', async () => {
  const gateway = new ScriptedGateway({
    windows: { B: { day1: 2 } },
    jobs: [{ key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j2', permitRef: 'PB' }]
  })
  const desk = makeDesk(gateway)
  const [, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemB, shift: 'day1' })
  const v1 = await desk.recordPermission({
    acceptanceNo: 'j2',
    segments: [{ itemId: itemB, interval: [1, 5], purpose: 'planning' }]
  })
  await desk.recordResult({ segmentId: v1.segmentIds[0], interval: [1, 5], headcount: 22, resultRef: 'z2' })
  const delivery = await desk.deliverRequest({ requestId: 'R1' })
  assert.equal(delivery.active, true)

  // 新版许可只收紧到 [2,5)：原 [1,5) 交付必须停用
  const v2 = await desk.recordPermission({
    acceptanceNo: 'j2',
    segments: [{ itemId: itemB, interval: [2, 5], purpose: 'planning' }]
  })
  const after = await desk.requestView('R1')
  const oldSeg = after.items[1].segments.find(s => s.id === v1.segmentIds[0])
  const newSeg = after.items[1].segments.find(s => s.id === v2.segmentIds[0])
  assert.equal(oldSeg.status, SEGMENT_STATUS.RETIRED)
  assert.equal(newSeg.status, SEGMENT_STATUS.WAITING)
  const retiredDelivery = after.deliveries[0]
  assert.equal(retiredDelivery.active, false)
  assert.ok(retiredDelivery.retiredReason.includes('许可收紧'))

  // 旧版大区间段不能再交付新缺项
  await assert.rejects(desk.deliverRequest({ requestId: 'R1' }), err => err.code === ERRORS.NOTHING_TO_DELIVER)

  // 新段达到门槛后按新版交付，合作方回执能区分两版
  await desk.recordResult({ segmentId: v2.segmentIds[0], interval: [2, 5], headcount: 9, resultRef: 'z2b' })
  const second = await desk.deliverRequest({ requestId: 'R1' })
  assert.equal(second.entries[0].permitVersion, 2)
  const receipts = await desk.partnerReceipts('member')
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].active, false)
  assert.equal(receipts[1].active, true)
})

test('用途与最新许可不符的段不允许交付', async () => {
  const gateway = new ScriptedGateway({
    windows: { B: { day1: 2 } },
    jobs: [{ key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j2', permitRef: 'PB' }]
  })
  const desk = makeDesk(gateway)
  const [, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemB, shift: 'day1' })
  const v1 = await desk.recordPermission({
    acceptanceNo: 'j2',
    segments: [{ itemId: itemB, interval: [1, 5], purpose: 'training' }] // 许可用途与分项 planning 不符
  })
  await desk.recordResult({ segmentId: v1.segmentIds[0], interval: [1, 5], headcount: 99, resultRef: 'zz' })
  await assert.rejects(desk.deliverRequest({ requestId: 'R1' }), err => err.code === ERRORS.NOTHING_TO_DELIVER)
})

test('局部取消停止后续领取，但受理占额保留在站账上', async () => {
  const gateway = new ScriptedGateway({
    windows: { A: { day1: 1 }, B: { day1: 2 } },
    jobs: [
      { key: 'desk-R1-I1-A-day1', station: 'A', shift: 'day1', acceptanceNo: 'j1', permitRef: 'PA' },
      { key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j2', permitRef: 'PB' }
    ]
  })
  const desk = makeDesk(gateway)
  const [itemA, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemA, shift: 'day1' })
  await desk.cancelItem({ itemId: itemA, reason: '合作方撤回' })
  await assert.rejects(desk.submitItem({ itemId: itemA, shift: 'day1' }), err => err.code === ERRORS.ITEM_CANCELLED)
  const ledger = await desk.siteLedger('A')
  assert.equal(ledger.windows[0].used, 1) // 占额保留
  // 另一站分项不受影响
  const ok = await desk.submitItem({ itemId: itemB, shift: 'day1' })
  assert.equal(ok.submission.outcome, 'accepted')
})

test('续办新请求范围变化后，旧许可材料不能补新缺项', async () => {
  const gateway = new ScriptedGateway({
    windows: { B: { day1: 2 }, B2: { day1: 1 } },
    jobs: [
      { key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j2', permitRef: 'PB' },
      { key: 'desk-R2-I3-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j7', permitRef: 'PG' }
    ]
  })
  const desk = makeDesk(gateway)
  const [, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemB, shift: 'day1' })
  const v1 = await desk.recordPermission({
    acceptanceNo: 'j2',
    segments: [{ itemId: itemB, interval: [1, 5], purpose: 'planning' }]
  })
  await desk.recordResult({ segmentId: v1.segmentIds[0], interval: [1, 5], headcount: 22, resultRef: 'z2' })
  await desk.deliverRequest({ requestId: 'R1' })

  // 续办：范围缩到 [6,8)，与旧许可完全不重叠
  const renewed = await desk.renewRequest({
    fromRequestId: 'R1', newRequestId: 'R2', partner: 'member', purpose: 'planning',
    items: [{ station: 'B', metric: 'count', interval: [6, 8], purpose: 'planning' }]
  })
  const newItem = renewed.itemIds[0]
  // 旧受理号下的段不属于新分项，新分项没有任何可交付材料
  await assert.rejects(desk.deliverRequest({ requestId: 'R2' }), err => err.code === ERRORS.NOTHING_TO_DELIVER)
  const trace = await desk.quotaTrace('R2')
  assert.equal(trace.length, 0)
  const oldTrace = await desk.quotaTrace('R1')
  assert.ok(oldTrace.some(row => row.acceptanceNo === 'j2'))
  const listed = await desk.listRequests()
  assert.equal(listed.find(r => r.id === 'R2').renewedFrom, 'R1')
})

test('额度去向可逐站解释：已受理查结果与未发申请分栏', async () => {
  const gateway = new ScriptedGateway({
    windows: { A: { day1: 1 } },
    jobs: [
      { key: 'desk-R1-I1-A-day1', station: 'A', shift: 'day1', acceptanceNo: 'j1', permitRef: 'PA' }
    ]
  })
  const desk = makeDesk(gateway)
  const [itemA] = await seed(desk, { A: { day1: 1 } })
  await desk.submitItem({ itemId: itemA, shift: 'day1' })
  const extra = await desk.createRequest({
    requestId: 'RX', partner: 'member', purpose: 'planning',
    items: [{ station: 'A', metric: 'count', interval: [2, 4], purpose: 'planning' }]
  })
  const extraItemId = extra.itemIds[0]
  gateway.jobs.set(`desk-RX-${extraItemId}-A-day1`, {
    key: `desk-RX-${extraItemId}-A-day1`, station: 'A', shift: 'day1', acceptanceNo: 'jx', permitRef: 'PX'
  })
  await desk.submitItem({ itemId: extraItemId, shift: 'day1' })
  const ledger = await desk.siteLedger('A')
  assert.deepEqual(ledger.windows[0].acceptanceNos, ['j1'])
  assert.equal(ledger.windows[0].blocked[0].outcome, 'quota-exhausted')
  assert.equal(ledger.windows[0].blocked[0].itemId, extra.itemIds[0])
})

test('结案后站方补出新版在途段，分项回到已受理；取消则为终局', async () => {
  const gateway = new ScriptedGateway({
    windows: { B: { day1: 2 } },
    jobs: [{ key: 'desk-R1-I2-B-day1', station: 'B', shift: 'day1', acceptanceNo: 'j3', permitRef: 'PB' }]
  })
  const desk = makeDesk(gateway)
  const [, itemB] = await seed(desk)
  await desk.submitItem({ itemId: itemB, shift: 'day1' })
  const v1 = await desk.recordPermission({
    acceptanceNo: 'j3',
    segments: [{ itemId: itemB, interval: [1, 2], purpose: 'planning' }]
  })
  await desk.recordResult({ segmentId: v1.segmentIds[0], interval: [1, 2], headcount: 1, resultRef: 'za' })
  assert.equal((await desk.requestView('R1')).items[1].status, ITEM_STATUS.CLOSED)
  // 站方后续补批一段新许可：分项重新打开继续跟
  const v2 = await desk.recordPermission({
    acceptanceNo: 'j3',
    segments: [
      { itemId: itemB, interval: [1, 2], purpose: 'planning' },
      { itemId: itemB, interval: [2, 4], purpose: 'planning' }
    ]
  })
  const reopened = await desk.requestView('R1')
  assert.equal(reopened.items[1].status, ITEM_STATUS.ACCEPTED)
  assert.equal(reopened.items[1].segments.find(s => s.id === v2.segmentIds[1]).status, SEGMENT_STATUS.WAITING)

  // 主动取消后即便再补许可也不恢复
  await desk.cancelItem({ itemId: itemB })
  await desk.recordPermission({
    acceptanceNo: 'j3',
    segments: [{ itemId: itemB, interval: [2, 5], purpose: 'planning' }]
  })
  assert.equal((await desk.requestView('R1')).items[1].status, ITEM_STATUS.CANCELLED)
})

test('半开区间工具拒绝非法输入且只支持包含/相交/交集', async () => {
  const a = new Interval(1, 5)
  assert.ok(a.covers(new Interval(2, 4)))
  assert.ok(a.intersects(new Interval(4, 6)))
  assert.deepEqual(a.intersection(new Interval(4, 6)).toJSON(), { from: 4, until: 5 })
  assert.equal(a.intersection(new Interval(5, 6)), null)
  assert.throws(() => new Interval(5, 5), err => err.code === ERRORS.INVALID_INTERVAL)
  assert.throws(() => Interval.parse('5-9'), err => err.code === ERRORS.INVALID_INTERVAL)
})
