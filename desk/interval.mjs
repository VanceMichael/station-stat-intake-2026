import { fail, ERRORS } from './errors.mjs'

// 半开区间 [from, until)，端点按整数序号（例如第几天）比较。
// 这里刻意只提供「包含 / 相交 / 取交集」三种运算，不提供区间相减：
// 缺项只能来自站方明确返回的段，禁止拿旧版大区间做减法推断。
export class Interval {
  constructor(from, until) {
    const start = Number(from)
    const end = Number(until)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
      fail(ERRORS.INVALID_INTERVAL, `非法半开区间 [${from}, ${until})，要求整数且 from < until`)
    }
    this.from = start
    this.until = end
  }

  static parse(text) {
    const match = /^\s*(-?\d+)\s*[:：]\s*(-?\d+)\s*$/.exec(String(text))
    if (!match) fail(ERRORS.INVALID_INTERVAL, `区间写法应为 from:until，收到「${text}」`)
    return new Interval(match[1], match[2])
  }

  static from(value) {
    if (value instanceof Interval) return value
    if (Array.isArray(value)) return new Interval(value[0], value[1])
    return new Interval(value.from, value.until)
  }

  contains(point) {
    return point >= this.from && point < this.until
  }

  covers(other) {
    return this.from <= other.from && other.until <= this.until
  }

  intersects(other) {
    return this.from < other.until && other.from < this.until
  }

  intersection(other) {
    const from = Math.max(this.from, other.from)
    const until = Math.min(this.until, other.until)
    return from < until ? new Interval(from, until) : null
  }

  equals(other) {
    return this.from === other.from && this.until === other.until
  }

  toString() {
    return `${this.from}:${this.until}`
  }

  toJSON() {
    return { from: this.from, until: this.until }
  }
}

export function sameInterval(a, b) {
  return Interval.from(a).equals(Interval.from(b))
}
