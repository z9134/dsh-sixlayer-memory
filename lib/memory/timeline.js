/**
 * timeline.js — 按天记录记忆与情绪变化（用户要的“日导图”）。
 *
 * 每天一个分支：
 *   日期
 *    ├─ 情绪事件（时间 + 标签 + 摘要）
 *    └─ 记忆条目（层 + 摘要）
 */
import { nowIso } from './util.js'

const LABEL_CN = { neutral: '中性', positive: '正面', negative: '负面', urgent: '紧急' }

/** ISO(UTC) → 本地 HH:mm */
function localTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    return String(iso).slice(11, 16)
  }
}

/** ISO(UTC) → 本地日期 YYYY-MM-DD */
function localDate(iso) {
  try {
    const d = new Date(iso)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  } catch {
    return String(iso).slice(0, 10)
  }
}

export function timeline({ store, days = 7 } = {}) {
  const span = Math.min(Math.max(Number(days) || 7, 1), 90)
  const since = new Date(Date.now() - span * 24 * 3600 * 1000).toISOString()

  const events = store.db
    .prepare('SELECT occurred_at, label, excerpt FROM affect_events WHERE occurred_at >= ? ORDER BY occurred_at')
    .all(since)
  const records = store.db
    .prepare("SELECT record_id, layer, sad_level, summary, created_at FROM records WHERE status = 'active' AND created_at >= ? ORDER BY created_at")
    .all(since)

  const byDate = new Map()
  const bucket = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date, affect: [], memories: [], counts: { neutral: 0, positive: 0, negative: 0, urgent: 0 } })
    return byDate.get(date)
  }

  for (const e of events) {
    const day = bucket(localDate(e.occurred_at))
    day.affect.push({ time: localTime(e.occurred_at), label: e.label, labelCn: LABEL_CN[e.label] ?? e.label, excerpt: e.excerpt })
    day.counts[e.label] = (day.counts[e.label] ?? 0) + 1
  }
  for (const r of records) {
    bucket(localDate(r.created_at)).memories.push({
      record_id: r.record_id,
      layer: r.layer,
      sad_level: r.sad_level,
      summary: String(r.summary ?? '').slice(0, 60),
    })
  }

  const dates = [...byDate.keys()].sort().reverse()
  return {
    days: span,
    since,
    dates,
    groups: dates.map((date) => byDate.get(date)),
    generatedAt: nowIso(),
  }
}
