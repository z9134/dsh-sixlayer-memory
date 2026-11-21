/**
 * affect-report.js — 情绪日报/周报（二期）。
 *
 * 输入：affectReport() 的聚合结果
 * 输出：Markdown 报告文本 + 落盘文件（dataDir/reports/affect/）
 */
import fs from 'node:fs'
import path from 'node:path'
import { affectReport } from './affect-events.js'

const LABEL_CN = { neutral: '中性', positive: '正面', negative: '负面', urgent: '紧急' }

export function buildAffectReportText(report, { title = null } = {}) {
  const labels = report.byLabel ?? {}
  const total = report.total ?? 0
  const lines = []
  lines.push(`# ${title ?? (report.range === 'week' ? '情绪周报' : '情绪日报')}`)
  lines.push('')
  lines.push(`- 区间：${report.range}（自 ${String(report.since).slice(0, 10)}）`)
  lines.push(`- 事件：${total} 条`)
  lines.push(`- 分布：${Object.keys(LABEL_CN).map((k) => `${LABEL_CN[k]} ${labels[k] ?? 0}`).join(' · ')}`)
  lines.push(`- 负面占比：${Math.round((report.negativeRatio ?? 0) * 100)}%`)
  lines.push('')

  if (report.topTriggers?.length) {
    lines.push('## 高频触发词')
    for (const item of report.topTriggers) lines.push(`- ${item.word} × ${item.n}`)
    lines.push('')
  }

  if (report.byHour?.length) {
    lines.push('## 时段分布（UTC）')
    const max = Math.max(...report.byHour.map((x) => x.n), 1)
    for (const item of report.byHour) {
      const bar = '█'.repeat(Math.max(1, Math.round((item.n / max) * 20)))
      lines.push(`- ${item.hour}时 ${bar} ${item.n}`)
    }
    lines.push('')
  }

  if (total === 0) lines.push('> 本期没有采集到情绪事件。')
  else if ((report.negativeRatio ?? 0) >= 0.5) lines.push('> 负面占比偏高，建议回看本期对话的触发点。')
  else lines.push('> 整体平稳。')

  return lines.join('\n')
}

/**
 * 生成并落盘报告。
 * @returns {{path: string, text: string, report: object}}
 */
export function saveAffectReport({ store, dataDir, range = 'day' }) {
  const report = affectReport({ store, range })
  const text = buildAffectReportText(report)
  const dir = path.join(dataDir, 'reports', 'affect')
  fs.mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, `${day}-${range}.md`)
  fs.writeFileSync(file, text + '\n', 'utf8')
  return { path: file, text, report }
}
