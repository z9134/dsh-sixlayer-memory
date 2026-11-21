// quarterly.mjs — 季度优化单（P3）：读最近 3 份月报，出参数建议。
// 红线：只提参数调整建议，不自动改任何配置。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = 'D:/001/CH002/dsh-memory-data'
const MONTHLY_DIR = path.join(DATA_DIR, 'reports', 'monthly')
const OUT_DIR = path.join(DATA_DIR, 'reports', 'quarterly')

function quarterOf(month) {
  const [y, m] = month.split('-').map(Number)
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`
}

const files = fs.existsSync(MONTHLY_DIR)
  ? fs.readdirSync(MONTHLY_DIR).filter((f) => f.endsWith('.json')).sort()
  : []

if (files.length === 0) {
  console.error('没有月报可读：先跑 tools/review.mjs --month YYYY-MM')
  process.exit(1)
}

const reports = files.slice(-3).map((f) => JSON.parse(fs.readFileSync(path.join(MONTHLY_DIR, f), 'utf8')))
const latest = reports[reports.length - 1]
const quarter = quarterOf(latest.month)

function metric(r, key) {
  switch (key) {
    case 'records': return r.total
    case 'new': return r.monthNew
    case 'hitRate': return r.search?.total ? r.search.hit / r.search.total : 0
    case 'pending': return r.pending
    case 'conflicts': return r.conflicts
    case 'dedupRate': return r.dedupRate
    case 'chainBreaks': return r.chainBreaks
    case 'fpr': return r.eval?.normal?.fpr ?? 0
    case 'l1': return r.eval?.levels?.L1?.rate ?? 0
    case 'l2': return r.eval?.levels?.L2?.rate ?? 0
    case 'l3': return r.eval?.levels?.L3?.rate ?? 0
    default: return null
  }
}

const METRICS = [
  ['records', '记录总数', 'int'],
  ['new', '本月新增', 'int'],
  ['hitRate', '检索命中率', 'pct'],
  ['pending', '待审积压', 'int'],
  ['conflicts', '冲突数', 'int'],
  ['dedupRate', '去重率', 'pct'],
  ['chainBreaks', '断链数', 'int'],
  ['fpr', '误报率', 'pct'],
  ['l1', 'L1 检出率', 'pct'],
  ['l2', 'L2 检出率', 'pct'],
  ['l3', 'L3 检出率', 'pct'],
]

function fmt(value, kind) {
  if (value === null || value === undefined) return '—'
  return kind === 'pct' ? pct(value) : String(value)
}

// ---------- 建议 ----------
const advice = []
const last = reports[reports.length - 1]
if ((last.chainBreaks ?? 0) > 0) advice.push({ level: 'P0', item: '审计链断裂', action: '立即跑 mem_audit --deep，修复前不要继续写入。', param: '—' })
if ((last.pending ?? 0) > 20) advice.push({ level: 'P1', item: `待审积压 ${last.pending} 条`, action: '集中审核一次；若持续积压，考虑把「未验证来源」的写入频率降下来。', param: '—' })
if ((last.eval?.normal?.fpr ?? 0) > 0.1) advice.push({ level: 'P1', item: `误报率 ${pct(last.eval.normal.fpr)}`, action: '逐条看命中的 scanner，关掉或收紧误伤的那条（scanner 可单独禁用）。', param: 'FPR 目标 ≤10%' })
if ((last.eval?.levels?.L1?.rate ?? 0) < 0.9) advice.push({ level: 'P1', item: 'L1 检出率下降', action: '检查 scanner 是否被误改；用固定测试集回归。', param: 'L1 目标 ≥90%' })
if ((last.eval?.levels?.L2?.rate ?? 0) === 0 || (last.eval?.levels?.L3?.rate ?? 0) === 0) advice.push({ level: 'P2', item: 'L2/L3 仍为结构性盲区', action: '不要靠加规则硬扛；继续靠注入侧组合检查（同批最多 1 条）兜底。', param: '—' })
if ((last.dedupRate ?? 0) > 0.3) advice.push({ level: 'P2', item: `去重率 ${pct(last.dedupRate)}`, action: '可能有重复写入源，检查是否有脚本在反复导入同一份内容。', param: '—' })
if (reports.length >= 2) {
  const prev = reports[reports.length - 2]
  if ((last.search?.total ?? 0) > 0 && (prev.search?.total ?? 0) > 0) {
    const before = prev.search.hit / prev.search.total
    const now = last.search.hit / last.search.total
    if (now < before - 0.2) advice.push({ level: 'P2', item: '命中率明显下降', action: '检查分词器与索引是否一致（mem_audit 会报 FTS 差异）。', param: '—' })
  }
}

// ---------- 产物 ----------
const lines = []
lines.push(`# 季度优化单 · ${quarter}`)
lines.push('')
lines.push(`- 生成时间：${new Date().toISOString()}`)
lines.push(`- 依据月报：${reports.map((r) => r.month).join(' / ')}`)
lines.push('- 口径：只给参数建议，**不自动修改任何配置**；每条建议都需人工确认。')
lines.push('')
lines.push('## 一、趋势')
lines.push('')
lines.push(`| 指标 | ${reports.map((r) => r.month).join(' | ')} |`)
lines.push(`|---|${reports.map(() => '---').join('|')}|`)
for (const [key, label, kind] of METRICS) {
  lines.push(`| ${label} | ${reports.map((r) => fmt(metric(r, key), kind)).join(' | ')} |`)
}
lines.push('')
lines.push('## 二、优化建议')
lines.push('')
if (advice.length === 0) {
  lines.push('本期没有需要调整的项：指标在阈值内，保持现状。')
} else {
  lines.push('| 级别 | 问题 | 建议动作 | 参数目标 |')
  lines.push('|---|---|---|---|')
  for (const a of advice) lines.push(`| ${a.level} | ${a.item} | ${a.action} | ${a.param} |`)
}
lines.push('')
lines.push('## 三、执行纪律')
lines.push('')
lines.push('- 只调参数，不改结构；结构变更另立方案。')
lines.push('- 任何阈值调整先跑固定测试集，报出 FPR 与检出率再定。')
lines.push('- 调完记录到本单的「执行记录」里，并保留回滚值。')
lines.push('')

fs.mkdirSync(OUT_DIR, { recursive: true })
const mdPath = path.join(OUT_DIR, `${quarter}.md`)
const jsonPath = path.join(OUT_DIR, `${quarter}.json`)
fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
fs.writeFileSync(jsonPath, JSON.stringify({ quarter, months: reports.map((r) => r.month), advice, generatedAt: new Date().toISOString() }, null, 2), 'utf8')

console.log(`已生成：${mdPath}`)
console.log(`已生成：${jsonPath}`)
console.log(`建议 ${advice.length} 条：`)
for (const a of advice) console.log(`  [${a.level}] ${a.item} -> ${a.action}`)
