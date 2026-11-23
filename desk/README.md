# 分项取数台

联络员管理跨站统计申请的工作台账：提交分项请求、追站点回执、按许可与发布门槛整理给合作方的材料。它不直接持有数据，站方事实通过 `source/` 模拟器的资料流对账进来；本地决定（发起、核对、取消、交付）完整留痕。

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `interval.mjs` | 半开区间 `[from, until)`，只提供包含、相交、交集，**刻意没有相减**，缺段只能来自站方明确返回 |
| `errors.mjs` | 规则错误码，调用方按 code 处理，不匹配文案 |
| `state.mjs` / `repository.mjs` | 可整体序列化的状态树；内存仓储（测试）与原子落盘的文件仓储（CLI） |
| `gateway.mjs` | 站方网关端口与脚本化实现，模拟受理、断线、待明确、窗口、耗尽五种结果 |
| `http-gateway.mjs` | 对接 `source/source.mjs` 的 HTTP 实现，含 TSV 翻页拉取 |
| `stateful.mjs` | 全部业务规则与查询视图（`Desk` 类） |
| `sync.mjs` | 把模拟器七个资料流幂等对账进台账，不替代本地决定 |
| `cli.mjs` | 联络员命令行，状态默认存 `records/desk.json` |

## 业务规则落点

- **一次受理即占班次额度**：站账按受理号计数；结果人数低于门槛（默认 5）或随后撤销都不释放（`#buildSiteLedger`、`recordResult`、`cancelItem`）。
- **断线先核对**：每个分项+班次绑定一个确定性「原请求键」。POST 断线只记 `disconnected`，再次提交直接复用该记录不发新请求；`confirmSubmission` 用同键 GET，查到受理才补登，202 保持 `pending`，404 确证未受理才允许同键重发。
- **班次门控**：本地只拦截「窗口未公布」；额度耗尽以站方写入口的 429 为准（其他渠道也可能占额），两类阻挡都进站账的「未发申请」分栏。下一班只有 `openShift`（或资料流公布新额度窗）后才可重试。
- **许可可缩短/部分批准、可出多版**：同一受理号挂多个独立统计段，每版许可带版本号。登记新版后旧段立即重判，不再被最新许可覆盖的：未发的标 `no-permission`，已发的把交付单标停用（`retired`），受理与占额不动。
- **交付三条件**：用途与分项一致、属于最新许可版本、结果人数达到站点门槛，三者同时满足才可发；交付单记录发出时的许可版本号。
- **四类缺项分栏**：尚无结果 `waiting`、人数未达门槛 `below-threshold`、主动取消 `cancelled`、已无权限 `no-permission`，另含可发/已发/停用，全部在 `requestView` 的 `buckets` 中逐段可查。
- **局部取消**：`cancelItem` 停止后续领取（等待/可发段转取消），但受理号留在站账；解释性状态（未达门槛、无权限）和已发交付保留。
- **续办隔离**：`renewRequest` 建新请求并记录 `renewedFrom`；旧受理的段挂在旧分项上，新分项没有自己的许可就什么都领不到，杜绝拿旧大区间材料补新缺项。
- **合作方回执**：`partnerReceipts` 列出每张交付单的有效性、条目与许可版本，能回答「合作方实际拿到了哪一版的哪些段」。

## CLI 用法

```sh
# 终端 1：起来源模拟器
npm run source
# 终端 2：取数台命令（DESK_STORE / SOURCE_URL 可覆盖默认值）
npm run desk -- sync all                 # 全量对账当前资料版
npm run desk -- sync all --edition r3    # 指定资料版
npm run desk -- list                     # 请求总览
npm run desk -- view --request R         # 分项、发起记录、段去向、交付单
npm run desk -- submit --item I1 --shift day1 --key r-a   # 发起（key 为来源侧客户请求键）
npm run desk -- confirm --submission Q8  # 断线/待明确后用原键核对
npm run desk -- ledger --station B       # 站账：已受理占额与未发申请分栏
npm run desk -- cancel --item I3 --reason 合作方撤回
npm run desk -- deliver --request R      # 发可交付的段
npm run desk -- receipts --partner member
npm run desk -- trace --request R        # 该请求各站额度去向
```

人工登记许可与结果（离线台账操作，演练时通常由 `sync` 自动完成）：

```sh
npm run desk -- permit j3 --segment I2:2:4:planning --segment I2:4:5:planning
npm run desk -- result --segment G9 --interval 2:4 --headcount 12 --ref z3
```

## 测试

- `test/desk.test.mjs`：14 条领域规则单测，用脚本化网关，不依赖网络。
- `test/desk-e2e.test.mjs`：3 条端到端用例，起真实 HTTP 模拟器，覆盖 r-a 断线核对、s-a 跨资料版班次门控、t-b 429、withdraw 撤销、issued 回执与门槛过滤。
