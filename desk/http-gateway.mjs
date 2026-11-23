// 对接本地来源模拟器（source/source.mjs）的站方网关实现。
// 模拟器在受理先于回执失败时会直接销毁 socket，fetch 表现为网络错误，
// 按规则映射为 disconnected：随后只能用同一个请求键 GET 核对。
export class HttpGateway {
  constructor(root) {
    this.root = root.replace(/\/$/, '')
  }

  async postRequest({ key }) {
    let response
    try {
      response = await fetch(`${this.root}/requests?client=${encodeURIComponent(key)}`, { method: 'POST' })
    } catch {
      return { outcome: 'disconnected' }
    }
    return this.#translate(response)
  }

  async confirmRequest({ key }) {
    let response
    try {
      response = await fetch(`${this.root}/requests?client=${encodeURIComponent(key)}`, { method: 'GET' })
    } catch {
      return { outcome: 'pending' }
    }
    return this.#translate(response)
  }

  async #translate(response) {
    if (response.status === 200 || response.status === 202) {
      const body = await response.json()
      if (body.status === 'received' && Array.isArray(body.receipt)) {
        // jobs 行：客户请求键、站、额度窗、受理号、审批号、状态
        const [, station, shift, acceptanceNo, permitRef, remoteStatus] = body.receipt
        return { outcome: 'received', receipt: { station, shift, acceptanceNo, permitRef, remoteStatus } }
      }
      return { outcome: 'pending' }
    }
    if (response.status === 404) return { outcome: 'unknown' }
    if (response.status === 409) return { outcome: 'window-not-open' }
    if (response.status === 429) return { outcome: 'quota-exhausted' }
    return { outcome: 'unknown' }
  }
}

// 拉取 TSV 数据流，自动跟随 Link: rel="next" 翻页。
export async function pullStream(root, stream, params = {}) {
  const url = new URL(`${root}/records/${stream}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const rows = []
  let next = url.toString()
  while (next) {
    const response = await fetch(next)
    // 资料版可以不包含某个数据流（例如 r1 没有 withdraw），按空流处理。
    if (response.status === 404) return rows
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(`拉取 ${stream} 失败：HTTP ${response.status} ${body.error ?? ''}`)
    }
    const text = await response.text()
    for (const line of text.split('\n').filter(Boolean)) rows.push(line.split('\t'))
    const link = response.headers.get('link')
    next = link ? new URL(/^<([^>]+)>/.exec(link)[1], root).toString() : null
  }
  return rows
}
