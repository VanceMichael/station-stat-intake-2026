// 站方网关端口。取数台核心只依赖这个接口，不关心背后是 HTTP 还是演练脚本。
//
// postRequest  发起受理，可能的 outcome：
//   received        站方已受理并给回执 { acceptanceNo, permitRef, remoteStatus }
//   window-not-open 该站本班次尚未公布额度
//   quota-exhausted 本班额度已花完
//   disconnected    响应断开，受理状态不明，必须走 confirmRequest 用原键核对
//   unknown         站方不认识该请求（演练用，正常流程不会出现）
//
// confirmRequest 用同一个请求键核对：
//   received        查到受理回执（断线后确认：站方其实已受理）
//   pending         站方仍在处理，状态未明确，禁止换键重发
//   unknown         确证未受理，此时才允许用原键再次发起
export class ScriptedGateway {
  constructor(scenario = {}) {
    // windows: { [station]: { [shift]: limit } }
    this.windows = scenario.windows ?? {}
    // jobs: [{ key, station, shift, acceptanceNo, permitRef, status }]
    this.jobs = new Map((scenario.jobs ?? []).map(job => [job.key, { ...job }]))
    this.accepted = new Set(scenario.previous ?? [])
    this.ackLost = new Set(scenario.ackLost ?? [])
    this.pendingOnce = new Set(scenario.pending ?? [])
    this.postLog = []
  }

  #window(station, shift) {
    return this.windows[station]?.[shift]
  }

  #used(station, shift) {
    let count = 0
    for (const key of this.accepted) {
      const job = this.jobs.get(key)
      if (job && job.station === station && job.shift === shift) count += 1
    }
    return count
  }

  async postRequest({ key }) {
    this.postLog.push(key)
    const job = this.jobs.get(key)
    if (!job) return { outcome: 'unknown' }
    if (this.accepted.has(key)) {
      return { outcome: 'received', receipt: this.#receipt(job) }
    }
    const limit = this.#window(job.station, job.shift)
    if (limit === undefined) return { outcome: 'window-not-open' }
    if (this.#used(job.station, job.shift) >= Number(limit)) {
      return { outcome: 'quota-exhausted' }
    }
    // 站方先占额受理，随后回执传输失败：额度已经花掉。
    this.accepted.add(key)
    if (this.ackLost.has(key)) return { outcome: 'disconnected' }
    return { outcome: 'received', receipt: this.#receipt(job) }
  }

  async confirmRequest({ key }) {
    const job = this.jobs.get(key)
    if (!job) return { outcome: 'unknown' }
    // 首次核对仍可能拿到「状态未明确」，即使站方随后会落账受理；
    // pendingOnce 只生效一次，下一次核对就能查到受理回执。
    if (this.pendingOnce.has(key)) {
      this.pendingOnce.delete(key)
      return { outcome: 'pending' }
    }
    if (this.accepted.has(key)) {
      return { outcome: 'received', receipt: this.#receipt(job) }
    }
    return { outcome: 'unknown' }
  }

  #receipt(job) {
    return {
      acceptanceNo: job.acceptanceNo,
      permitRef: job.permitRef,
      remoteStatus: job.status ?? 'accepted'
    }
  }
}
