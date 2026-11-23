// 取数台的全部状态集中在一棵普通对象树上，便于整体序列化落盘。
// 各实体之间只用 id 引用，领域逻辑放在 stateful.mjs。

export function createState() {
  return {
    seq: 0,
    sites: {}, // stationId -> { id, name, threshold }
    shifts: {}, // stationId -> [{ shift, limit, openedAt }]
    requests: {}, // requestId -> 请求
    items: {}, // itemId -> 分项
    submissions: {}, // submissionId -> 一次发起/确认记录
    keyIndex: {}, // requestKey -> submissionId（原请求键）
    acceptances: {}, // acceptanceNo -> 站方受理
    segments: {}, // segmentId -> 许可下的统计段
    deliveries: {}, // deliveryId -> 给合作方的一次交付
    cancelled: {}, // itemId -> { at, reason }
    retiredDeliveries: {}, // deliveryId -> { at, reason }
    requestIndex: [] // 有序的请求 id，便于列表展示
  }
}

export function nextId(state, prefix) {
  state.seq += 1
  return `${prefix}${state.seq}`
}

// 深拷贝配合内存仓储使用；JSON 可序列化是状态树的硬约束。
export function cloneState(state) {
  return JSON.parse(JSON.stringify(state))
}
