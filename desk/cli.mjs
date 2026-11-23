#!/usr/bin/env node
// 分项取数台命令行。每个子命令是一次独立进程调用，状态落在 JSON 文件里。
import { parseArgs } from 'node:util'
import { FileRepository } from './repository.mjs'
import { HttpGateway } from './http-gateway.mjs'
import { Desk, ITEM_STATUS, SEGMENT_STATUS } from './stateful.mjs'
import { Interval } from './interval.mjs'
import { DeskError } from './errors.mjs'
import { syncAll, syncSites, syncRequests, syncPermissions, syncResults, syncStationFacts, syncJobs } from './sync.mjs'

const STORE = process.env.DESK_STORE || 'records/desk.json'
const SOURCE = process.env.SOURCE_URL || 'http://127.0.0.1:8700'

function desk(gateway = new HttpGateway(SOURCE)) {
  return new Desk(new FileRepository(STORE), gateway)
}

function parseItems(values) {
  // --item 站:指标:from:until:用途，可重复
  return values.map(text => {
    const parts = text.split(':')
    if (parts.length < 4) throw new DeskError('invalid-interval', `--item 写法 站:指标:from:until[:用途]，收到「${text}」`)
    const [station, metric, from, until, purpose] = parts
    return { station, metric, interval: [Number(from), Number(until)], ...(purpose ? { purpose } : {}) }
  })
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

const STATUS_CN = {
  [ITEM_STATUS.PENDING]: '待发起',
  [ITEM_STATUS.BLOCKED]: '被班次挡住',
  [ITEM_STATUS.ACCEPTED]: '已受理',
  [ITEM_STATUS.CANCELLED]: '已取消',
  [ITEM_STATUS.CLOSED]: '已结案'
}

const SEG_CN = {
  [SEGMENT_STATUS.WAITING]: '尚无结果',
  [SEGMENT_STATUS.BELOW_THRESHOLD]: '人数未达门槛',
  [SEGMENT_STATUS.NO_PERMISSION]: '已无权限',
  [SEGMENT_STATUS.DELIVERABLE]: '可交付',
  [SEGMENT_STATUS.DELIVERED]: '已发出',
  [SEGMENT_STATUS.RETIRED]: '已停用',
  [SEGMENT_STATUS.CANCELLED]: '已取消'
}

function humanRequestView(view) {
  const lines = []
  const r = view.request
  lines.push(`请求 ${r.id}｜合作方 ${r.partner}｜用途 ${r.purpose}${r.renewedFrom ? `｜续办自 ${r.renewedFrom}` : ''}`)
  for (const item of view.items) {
    lines.push(`  分项 ${item.id} 站${item.station} ${item.metric} [${item.interval.from}:${item.interval.until}) 用途=${item.purpose} -> ${STATUS_CN[item.status]}`)
    for (const s of item.submissions) {
      lines.push(`    发起 ${s.id} 键=${s.key} 班次=${s.shift} 结果=${s.outcome} 尝试=${s.attempts}${s.acceptanceNo ? ` 受理号=${s.acceptanceNo}` : ''}`)
    }
    for (const seg of item.segments) {
      const iv = seg.result ? `[${seg.result.from}:${seg.result.until})` : `[${seg.interval.from}:${seg.interval.until})`
      const head = seg.result ? ` 人数=${seg.result.headcount} 结果号=${seg.result.resultRef}` : ''
      lines.push(`    段 ${seg.id} v${seg.version}${seg.latest ? '★' : ''} ${iv} 用途=${seg.purpose} -> ${SEG_CN[seg.status]}${head}`)
    }
    const b = item.buckets
    lines.push(`    去向：尚无结果[${b.waiting.length}] 未达门槛[${b.belowThreshold.length}] 已取消[${b.cancelled.length}] 无权限[${b.noPermission.length}] 可发[${b.deliverable.length}] 已发[${b.delivered.length}] 停用[${b.retired.length}]`)
  }
  for (const d of view.deliveries) {
    lines.push(`  交付单 ${d.id} ${d.active ? '有效' : '已停用'}${d.retiredReason ? `（${d.retiredReason}）` : ''}`)
    for (const e of d.entries) lines.push(`    发出 段${e.segmentId} 站${e.station} [${e.interval.from}:${e.interval.until}) 结果号=${e.resultRef} 许可v${e.permitVersion}`)
  }
  return lines.join('\n')
}

const commands = {
  async site(parsed) {
    const { values } = parsed
    return desk().registerSite({ stationId: values.id, name: values.name, threshold: Number(values.threshold ?? 5) })
  },

  async shift(parsed) {
    const { values } = parsed
    return desk().openShift({ stationId: values.station, shift: values.shift, limit: Number(values.limit) })
  },

  async ledger(parsed) {
    return desk().siteLedger(parsed.values.station)
  },

  async request(parsed) {
    const { values } = parsed
    return desk().createRequest({
      requestId: values.id,
      partner: values.partner,
      purpose: values.purpose,
      items: parseItems(values.item ?? [])
    })
  },

  async renew(parsed) {
    const { values } = parsed
    return desk().renewRequest({
      fromRequestId: values.from,
      newRequestId: values.id,
      partner: values.partner,
      purpose: values.purpose,
      items: parseItems(values.item ?? [])
    })
  },

  async submit(parsed) {
    const d = desk()
    return d.submitItem({
      itemId: parsed.values.item,
      shift: parsed.values.shift,
      ...(parsed.values.key ? { requestKey: parsed.values.key } : {})
    })
  },

  async confirm(parsed) {
    return desk().confirmSubmission({ submissionId: parsed.values.submission })
  },

  async permit(parsed) {
    const { values, positionals } = parsed
    const d = desk()
    const segments = (values.segment ?? []).map(text => {
      const [itemId, from, until, purpose] = text.split(':')
      return { itemId, interval: [Number(from), Number(until)], ...(purpose ? { purpose } : {}) }
    })
    return d.recordPermission({ acceptanceNo: positionals[0], segments })
  },

  async result(parsed) {
    const { values } = parsed
    return desk().recordResult({
      segmentId: values.segment,
      interval: Interval.parse(values.interval),
      headcount: Number(values.headcount),
      resultRef: values.ref
    })
  },

  async cancel(parsed) {
    return desk().cancelItem({ itemId: parsed.values.item, reason: parsed.values.reason ?? '' })
  },

  async deliver(parsed) {
    return desk().deliverRequest({ requestId: parsed.values.request })
  },

  async view(parsed) {
    const d = desk()
    const view = await d.requestView(parsed.values.request)
    return parsed.values.json ? view : humanRequestView(view)
  },

  async trace(parsed) {
    return desk().quotaTrace(parsed.values.request)
  },

  async receipts(parsed) {
    return desk().partnerReceipts(parsed.values.partner)
  },

  async list() {
    return desk().listRequests()
  },

  async sync(parsed) {
    const d = desk()
    const options = { edition: parsed.values.edition }
    const name = parsed.positionals[0] ?? 'all'
    const map = { all: syncAll, sites: syncSites, requests: syncRequests, permissions: syncPermissions, results: syncResults, facts: syncStationFacts, jobs: syncJobs }
    if (!map[name]) throw new DeskError('not-found', `未知同步范围：${name}`)
    return map[name](d, SOURCE, options)
  }
}

const OPTIONS = {
  site: { options: { id: { type: 'string' }, name: { type: 'string' }, threshold: { type: 'string' } } },
  shift: { options: { station: { type: 'string' }, shift: { type: 'string' }, limit: { type: 'string' } } },
  ledger: { options: { station: { type: 'string' } } },
  request: { options: { id: { type: 'string' }, partner: { type: 'string' }, purpose: { type: 'string' }, item: { type: 'string', multiple: true } } },
  renew: { options: { from: { type: 'string' }, id: { type: 'string' }, partner: { type: 'string' }, purpose: { type: 'string' }, item: { type: 'string', multiple: true } } },
  submit: { options: { item: { type: 'string' }, shift: { type: 'string' }, key: { type: 'string' } } },
  confirm: { options: { submission: { type: 'string' } } },
  permit: { options: { segment: { type: 'string', multiple: true } } },
  result: { options: { segment: { type: 'string' }, interval: { type: 'string' }, headcount: { type: 'string' }, ref: { type: 'string' } } },
  cancel: { options: { item: { type: 'string' }, reason: { type: 'string' } } },
  deliver: { options: { request: { type: 'string' } } },
  view: { options: { request: { type: 'string' }, json: { type: 'boolean', default: false } } },
  trace: { options: { request: { type: 'string' } } },
  receipts: { options: { partner: { type: 'string' } } },
  list: { options: {} },
  sync: { options: { edition: { type: 'string' } } }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || !commands[command]) {
    process.stdout.write(`分项取数台\n用法: node desk/cli.mjs <${Object.keys(commands).join('|')}> [选项]\n存储: DESK_STORE=${STORE}\n来源: SOURCE_URL=${SOURCE}\n`)
    process.exit(command ? 1 : 0)
  }
  const parsed = parseArgs({ args: rest, options: OPTIONS[command].options, allowPositionals: true })
  const output = await commands[command](parsed)
  print(output)
}

main().catch(error => {
  if (error instanceof DeskError) {
    process.stdout.write(JSON.stringify({ error: error.code, message: error.message }, null, 2) + '\n')
    process.exit(2)
  }
  console.error(error)
  process.exit(1)
})
