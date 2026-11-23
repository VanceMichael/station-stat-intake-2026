import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../source/source.mjs'
import { FileRepository } from '../desk/repository.mjs'
import { HttpGateway } from '../desk/http-gateway.mjs'
import { Desk, ITEM_STATUS, SEGMENT_STATUS } from '../desk/stateful.mjs'
import { syncAll, syncSites } from '../desk/sync.mjs'

async function listen(t) {
  const server = createSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

async function freshDesk(t, root) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return new Desk(new FileRepository(join(dir, 'desk.json')), new HttpGateway(root),
    { clock: (() => { let n = 0; return () => `t${++n}` })() })
}

test('端到端：对账 r1 资料，门槛过滤与已发记录一致', async t => {
  const root = await listen(t)
  const desk = await freshDesk(t, root)
  const summary = await syncAll(desk, root)
  assert.deepEqual(summary.sites.stations.sort(), ['A', 'B'])
  assert.ok(summary.requests.includes('R'))

  const view = await desk.requestView('R')
  assert.equal(view.items.length, 2)
  const stationB = view.items.find(i => i.station === 'B')
  const seg = stationB.segments[0]
  assert.equal(seg.status, SEGMENT_STATUS.DELIVERED) // rows: 22 人，且 issued 流已记录
  assert.equal(seg.result.resultRef, 'z2')
  assert.equal(view.deliveries.length, 1)

  // 站账：B 班 day1 上限 2，已用 2（r-b、r-b2 都在 r2 才受理，这里 r1 只有 r-b）
  const ledgerB = await desk.siteLedger('B')
  assert.equal(ledgerB.windows[0].limit, 2)
})

test('端到端：r-a 断线先核对再补登，跨资料版额度按班次门控', async t => {
  const root = await listen(t)
  const desk = await freshDesk(t, root)
  await syncAll(desk, root)
  const viewR = await desk.requestView('R')
  const itemA = viewR.items.find(i => i.station === 'A')

  // r-a 首次受理连接断开（模拟器脚本），本地记为 disconnected
  const first = await desk.submitItem({ itemId: itemA.id, shift: 'day1', requestKey: 'r-a' })
  assert.equal(first.submission.outcome, 'disconnected')

  // 同键核对：站方其实已受理 j1，不重复扣额度
  const confirmed = await desk.confirmSubmission({ submissionId: first.submission.id })
  assert.equal(confirmed.submission.acceptanceNo, 'j1')
  const ledgerA = await desk.siteLedger('A')
  assert.equal(ledgerA.windows[0].used, 1)

  // 切到 r2：s-a 对应 day2，r2 尚未公布该班次 -> 409 窗口未开
  await fetch(root + '/control?edition=r2', { method: 'POST' })
  const requestS = await desk.requestView('S')
  const sItem = requestS.items[0]
  const blocked = await desk.submitItem({ itemId: sItem.id, shift: 'day2', requestKey: 's-a' })
  assert.equal(blocked.submission.outcome, 'window-not-open')

  // r3 公布 day2 额度后，用原请求键重新发起（不是换新键），受理 j4
  await fetch(root + '/control?edition=r3', { method: 'POST' })
  // 先让本地台账知道新班次额度，再由联络员用原键重试
  await syncSites(desk, root, { edition: 'r3' })
  const retry = await desk.submitItem({ itemId: sItem.id, shift: 'day2', requestKey: 's-a' })
  assert.equal(retry.submission.outcome, 'accepted')
  assert.equal(retry.submission.acceptanceNo, 'j4')

  // 模拟器脚本里 s-a 的首次核对返回 202（状态未明确）；已受理的记录
  // 再核对只是复用，台账绝不会为此发起第二次 POST。
  const pending = await desk.confirmSubmission({ submissionId: retry.submission.id })
  assert.equal(pending.reused, true)

  // B 站 day2 上限 1：u-b 先成功占额（j6），t-b 再领时站方写入口返回 429。
  const uItem = (await desk.requestView('U')).items[0]
  const uOk = await desk.submitItem({ itemId: uItem.id, shift: 'day2', requestKey: 'u-b' })
  assert.equal(uOk.submission.outcome, 'accepted')
  assert.equal(uOk.submission.acceptanceNo, 'j6')

  const viewT = await desk.requestView('T')
  const tItem = viewT.items[0]
  const exhausted = await desk.submitItem({ itemId: tItem.id, shift: 'day2', requestKey: 't-b' })
  assert.equal(exhausted.submission.outcome, 'quota-exhausted')
  assert.equal((await desk.requestView('T')).items[0].status, ITEM_STATUS.BLOCKED)

  await syncAll(desk, root, { edition: 'r3' })

  // r3 结果：j1 只有 3 人，低于门槛 5，不能发给合作方
  const after = await desk.requestView('R')
  const itemAview = after.items.find(i => i.station === 'A')
  const j1seg = itemAview.segments.find(s => s.acceptanceNo === 'j1')
  assert.ok(j1seg, 'r-a 对应的 j1 段应已补登')
  assert.equal(j1seg.status, SEGMENT_STATUS.BELOW_THRESHOLD)
  await assert.rejects(desk.deliverRequest({ requestId: 'R' }), err => err.code === 'nothing-to-deliver')

  const ledgerB = await desk.siteLedger('B')
  const day2 = ledgerB.windows.find(w => w.shift === 'day2')
  assert.equal(day2.remaining, 0)
  assert.deepEqual(day2.acceptanceNos, ['j6'])
  assert.ok(day2.blocked.some(b => b.outcome === 'quota-exhausted'))

  // 合作方回执：R 仅拿到 B 站 z2 一版
  const receipts = await desk.partnerReceipts('member')
  const entries = receipts.flatMap(d => d.entries)
  assert.deepEqual(entries.map(e => e.resultRef), ['z2'])
})

test('端到端：撤销流驱动局部取消，已受理占额不回退', async t => {
  const root = await listen(t)
  const desk = await freshDesk(t, root)
  await fetch(root + '/control?edition=r2', { method: 'POST' })
  await syncAll(desk, root, { edition: 'r2' })
  const viewT = await desk.requestView('T')
  assert.equal(viewT.items[0].status, ITEM_STATUS.CANCELLED)
  // T 尚未成功受理过，站账上没有它的占额
  const ledgerB = await desk.siteLedger('B')
  const day1 = ledgerB.windows.find(w => w.shift === 'day1')
  assert.ok(!day1.acceptanceNos.includes('j5'))
})
