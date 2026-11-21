// review.mjs — 月度回顾（P2）：十项指标 + 固定测试集评测 → md + json。
// 用法：node tools/review.mjs [--month 2026-10] [--out <目录>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import MemoryStore from '../lib/memory/store.js'
import { evaluateScanners } from './eval.mjs'

const DATA_DIR = 'D:/001/CH002/dsh-memory-data'
const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const month = arg('--month', new Date().toISOString().slice(0, 7))
const outDir = arg('--out', path.join(DATA_DIR, 'reports', 'monthly'))
fs.mkdirSync(outDir, { recursive: true })

const store = new MemoryStore({ dataDir: DATA_DIR }).open()
const db = store.db

const one = (sql, ...params) => db.prepare(sql).get(...params)
const all = (sql, ...params) => db.prepare(sql).all(...params)

// ---------- 1. 采数 ----------
const monthNew = one('SELECT count(*) n FROM records WHERE substr(created_at,1,7) = ?', month).n
const total = one('SELECT count(*) n FROM records').n
const ops = Object.fromEntries(all('SELECT op, count(*) n FROM traces WHERE substr(at,1,7) = ? GROUP BY op', month).map((r) => [r.op, r.n]))

const searchRows = all("SELECT hits FROM traces WHERE substr(at,1,7) = ? AND op = 'search'", month)
const hitCount = searchRows.filter((r) => {
  try {
    return JSON.parse(r.hits || '[]').length > 0
  } catch {
    return false
  }
}).length

const injectRows = all("SELECT injected FROM traces WHERE substr(at,1,7) = ? AND op = 'inject'", month)
const avgInjected = injectRows.length
  ? Math.round((injectRows.reduce((sum, r) => {
      try {
        return sum + JSON.parse(r.injected || '[]').length
      } catch {
        return sum
      }
    }, 0) / injectRows.length) * 10) / 10
  : 0

const pending = one('SELECT count(*) n FROM review_queue WHERE decision IS NULL').n
const conflicts = one('SELECT count(*) n FROM records WHERE conflict_of IS NOT NULL').n
const writes = (ops.write || 0) + (ops['write.dedup'] || 0)
const dedupRate = writes ? (ops['write.dedup'] || 0) / writes : 0
const stats = store.stats()
const auditOk = stats.audit?.ok === true
const chainBreaks = auditOk ? 0 : 1

// ---------- 2. 评测 ----------
const evalr = evaluateScanners()
const l1Rate = evalr.levels.L1?.rate ?? 0
const l2Rate = evalr.levels.L2?.rate ?? 0
const l3Rate = evalr.levels.L3?.rate ?? 0
const missRate = 1 - l1Rate
const fpr = evalr.normal.fpr

function pct(x) {
  return `${(x * 100).toFixed(1)}%`
}

const metrics = [
  ['新增记录', String(monthNew), '本月写入并落库的记录数'],
  ['命中率', pct(searchRows.length ? hitCount / searchRows.length : 0), `${hitCount}/${searchRows.length} 次检索有结果`],
  ['零命中率', pct(searchRows.length ? 1 - hitCount / searchRows.length : 0), '检索完全没结果的比例'],
  ['待审积压', String(pending), 'review_queue 中未裁决的条数'],
  ['冲突数', String(conflicts), '带 conflict_of 的记录数'],
  ['注入强度', `${avgInjected} 条/次`, `本月注入 ${injectRows.length} 次，平均每次带 ${avgInjected} 条指针`],
  ['去重率', pct(dedupRate), `${ops['write.dedup'] || 0}/${writes} 次写入命中已有内容`],
  ['断链数', String(chainBreaks), auditOk ? '审计链一致' : '审计链断裂，需立即处理'],
  ['误报率 FPR', pct(fpr), `正常样本被误判为攻击：${evalr.normal.flagged}/${evalr.normal.total}`],
  ['L1 漏检率', pct(missRate), `L1 漏检 ${pct(missRate)}；L2 逃逸 ${pct(1 - l2Rate)}；L3 逃逸 ${pct(1 - l3Rate)}`],
]

// ---------- 3. 产物 ----------
const lines = []
lines.push(`# 记忆底座月度回顾 · ${month}`)
lines.push('')
lines.push(`- 生成时间：${new Date().toISOString()}`)
lines.push(`- 权威源：${stats.authority}｜库：${total} 条｜schema v${stats.schemaVersion}`)
lines.push(`- 测试集：${evalr.testset.version}（构造哈希 ${evalr.testset.hash}，${evalr.testset.count} 条）`)
lines.push('')
lines.push('## 一、十项指标')
lines.push('')
lines.push('| 指标 | 值 | 说明 |')
lines.push('|---|---|---|')
for (const [k, v, d] of metrics) lines.push(`| ${k} | ${v} | ${d} |`)
lines.push('')
lines.push('## 二、工作点上的检出情况')
lines.push('')
lines.push('| 级别 | 样本 | 检出 | 检出率 |')
lines.push('|---|---|---|---|')
for (const [level, v] of Object.entries(evalr.levels)) lines.push(`| ${level} | ${v.total} | ${v.caught} | ${pct(v.rate)} |`)
lines.push('')
lines.push(`整体：recall ${pct(evalr.overall.recall)}，precision ${pct(evalr.overall.precision)}。`)
lines.push('')
lines.push('## 三、判断与下一步')
lines.push('')
if (!auditOk) lines.push('- ⚠ 审计链断裂：先跑 `mem_audit --deep`，不要继续写入。')
if (pending > 20) lines.push(`- ⚠ 待审积压 ${pending} 条：闸门堵住了，需要安排一次集中审核。`)
if (l2Rate < 0.5) lines.push('- L2（组合攻击）检出率偏低——这是扫描器的结构性盲区，靠注入侧的组合检查兜底，不能指望规则。')
if (l3Rate < 0.5) lines.push('- L3（休眠触发）检出率偏低——同上，属于公开难题，不要对外宣称能防住。')
if (fpr > 0.1) lines.push('- 误报率偏高：先看是不是某条 scanner 在误伤，月度调参时优先处理。')
lines.push('- 本报告只描述工作点，不宣称"能防住"；任何检测结论都要带上测试集版本与误报率。')
lines.push('')

const mdPath = path.join(outDir, `${month}.md`)
const jsonPath = path.join(outDir, `${month}.json`)
fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
fs.writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      month,
      generatedAt: new Date().toISOString(),
      authority: stats.authority,
      total,
      monthNew,
      ops,
      search: { total: searchRows.length, hit: hitCount },
      inject: { count: injectRows.length, avgRecords: avgInjected },
      pending,
      conflicts,
      dedupRate,
      chainBreaks,
      eval: evalr,
    },
    null,
    2,
  ),
  'utf8',
)

store.close()
console.log(`已生成：${mdPath}`)
console.log(`已生成：${jsonPath}`)
console.log('')
for (const [k, v] of metrics) console.log(`  ${k}: ${v}`)

// P3：--send 时逐级兜底发送（SMTP → 飞书 → 本地 outbox），报告永远先落盘
if (process.argv.includes('--send')) {
  const { sendReport } = await import('../lib/notify.js')
  const result = await sendReport({ subject: `记忆底座月报 ${month}`, text: lines.join('\n') })
  console.log('')
  console.log('通知结果:', JSON.stringify(result))
}
