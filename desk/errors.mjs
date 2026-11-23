// 业务规则错误：所有违反取数台规则的操作都抛出这些类型，
// 调用方（CLI / 测试）可以按 code 区分，而不是匹配错误文案。
export class DeskError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'DeskError'
    this.code = code
    Object.assign(this, extra)
  }
}

export const ERRORS = {
  NOT_FOUND: 'not-found',
  DUPLICATE_KEY: 'duplicate-key',
  KEY_MISMATCH: 'key-mismatch',
  WINDOW_NOT_OPEN: 'window-not-open',
  QUOTA_EXHAUSTED: 'quota-exhausted',
  DISCONNECTED: 'disconnected',
  PENDING: 'pending',
  UNKNOWN_REMOTE: 'unknown-remote',
  ALREADY_ACCEPTED: 'already-accepted',
  ITEM_CANCELLED: 'item-cancelled',
  NO_PERMISSION: 'no-permission',
  NO_RESULT: 'no-result',
  BELOW_THRESHOLD: 'below-threshold',
  ALREADY_DELIVERED: 'already-delivered',
  DELIVERY_RETIRED: 'delivery-retired',
  NOTHING_TO_DELIVER: 'nothing-to-deliver',
  INVALID_INTERVAL: 'invalid-interval'
}

export function fail(code, message, extra) {
  throw new DeskError(code, message, extra)
}
