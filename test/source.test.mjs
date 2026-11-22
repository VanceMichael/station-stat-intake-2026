import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createSource } from '../source/source.mjs'

async function listen(t) {
  const server = createSource()
  server.listen(0, '127.0.0.1')
  await once(server,'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { root: 'http://127.0.0.1:' + server.address().port }
}

test('来源资料支持修订隔离与逐页领取', async t => {
  const { root } = await listen(t)
  const update = await fetch(root + '/control?edition=r2', {method:'POST'})
  assert.equal((await update.json()).edition, 'r2')
  let response = await fetch(root + '/records/' + "permit")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Edition'), 'r2')
  const etag = response.headers.get('ETag')
  const cached = await fetch(root + '/records/' + "permit", {headers:{'If-None-Match':etag}})
  assert.equal(cached.status, 304)
  const rows = []
  for (;;) {
    rows.push(...(await response.text()).trim().split('\n').filter(Boolean))
    const next = response.headers.get('link')
    if (!next) break
    const path = /^<([^>]+)>/.exec(next)[1]
    const incorrect = new URL(path, root)
    incorrect.searchParams.set('edition','r1')
    assert.ok([404,409].includes((await fetch(incorrect)).status))
    response = await fetch(new URL(path,root))
    assert.equal(response.status, 200)
  }
  assert.equal(new Set(rows).size,rows.length)
  assert.ok(rows.some(row => row.split('\t').includes("2")))
})

test('源站受理发生在回执传输失败之前', async t => {
  const { root } = await listen(t)
  const route = root + '/requests?client=r-a'
  await assert.rejects(fetch(route,{method:'POST'}))
  const response = await fetch(route)
  assert.equal(response.status,200)
  assert.equal((await response.json()).receipt[3],'j1')
  await fetch(root + '/control?edition=r2',{method:'POST'})
  const second = root + '/requests?client=s-a'
  assert.equal((await fetch(second,{method:'POST'})).status,409)
  assert.equal((await fetch(second)).status,202)
  await fetch(root + '/control?edition=r3',{method:'POST'})
  const receipt = await fetch(second,{method:'POST'})
  assert.equal(receipt.status,202)
  assert.equal((await receipt.json()).receipt[3],'j4')
  const valid = await fetch(root + '/requests?client=u-b',{method:'POST'})
  assert.equal((await valid.json()).receipt[3],'j6')
  const full = await fetch(root + '/requests?client=t-b',{method:'POST'})
  assert.equal(full.status,429)
})
