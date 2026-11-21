/**
 * affect-events.js — 情绪事件采集与分析（一期：只采 QQ）。
 *
 * 数据源：DSH 会话日志
 *   ~/.dsh/sessions/--…-dsh-qqbot-workspace--/session-<id>/session.v4.jsonl.zstd
 *   文件是多帧 zstd（追加写），需要逐帧解压。
 *
 * 口径：
 *   - 只取 user/message（用户说的话）
 *   - 只存 ≤80 字脱敏摘要，不存全文
 *   - 按 (session_id, excerpt_hash, occurred_at) 去重
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { analyzeAffect } from './emotion.js'
import { redact, brief } from './redact.js'
import { sha256, nowIso } from './util.js'

const QQ_WORKSPACE_MARK = 'dsh-qqbot-workspace'
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 多帧 zstd：按魔数切帧，逐帧解压。 */
export function decodeZstdFrames(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  starts.push(buffer.length)
  let text = ''
  for (let k = 0; k < starts.length - 1; k += 1) {
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(starts[k], starts[k + 1])).toString('utf8')
    } catch {
      /* 误命中或坏帧，跳过 */
    }
  }
  return text
}

/** 从会话日志文本里抽出用户消息。 */
export function extractUserMessages(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'user/message') continue
    // 只收真实用户消息：runtime-context / time-context / skill-catalog 都是注入的
    const kind = event.data?.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const parts = Array.isArray(event.data?.content) ? event.data.content : []
    const body = parts
      .filter((p) => p && p.type === 'text')
      .map((p) => String(p.text ?? ''))
      .join(' ')
      .trim()
    if (!body) continue
    out.push({
      id: event.data?.id ?? null,
      time: event.time ? new Date(Number(event.time)).toISOString() : nowIso(),
      text: body,
    })
  }
  return out
}

/** 找 QQ 工作区下的会话文件（新→旧）。 */
export function findQqSessions(sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  const out = []
  if (!fs.existsSync(sessionsRoot)) return out
  for (const ws of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory() || !ws.name.includes(QQ_WORKSPACE_MARK)) continue
    const wsDir = path.join(sessionsRoot, ws.name)
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const file = path.join(wsDir, s.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      out.push({ sessionId: s.name, file, mtime: fs.statSync(file).mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * 采集：解析最近 limit 个 QQ 会话，写入 affect_events。
 * @returns {{files: number, scanned: number, added: number, skipped: number, labels: object}}
 */
export function ingestQqSessions({ store, sessionsRoot, limit = 20, source = 'qq' }) {
  const files = findQqSessions(sessionsRoot).slice(0, Math.max(1, Number(limit) || 20))
  const insert = store.db.prepare(
    `INSERT OR IGNORE INTO affect_events
       (event_id, session_id, source, occurred_at, label, valence, arousal, excerpt, excerpt_hash, triggers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const labels = { neutral: 0, positive: 0, negative: 0, urgent: 0 }
  let scanned = 0
  let added = 0
  let skipped = 0

  for (const file of files) {
    let text
    try {
      text = decodeZstdFrames(fs.readFileSync(file.file))
    } catch {
      continue
    }
    for (const message of extractUserMessages(text)) {
      scanned += 1
      const safe = redact(message.text).text ?? message.text
      const excerpt = brief(String(safe ?? message.text), 80)
      const hash = sha256(excerpt)
      const affect = analyzeAffect(message.text)
      const eventId = `ae_${hash.slice(0, 16)}_${message.time}`
      const result = insert.run(
        eventId,
        file.sessionId,
        source,
        message.time,
        affect.label,
        affect.valence,
        affect.arousal,
        excerpt,
        hash,
        JSON.stringify(affect.words ?? []),
        nowIso(),
      )
      if (result.changes > 0) {
        added += 1
        labels[affect.label] += 1
      } else {
        skipped += 1
      }
    }
  }

  return { files: files.length, scanned, added, skipped, labels }
}

const RANGE_DAYS = { day: 1, week: 7, month: 30 }

/**
 * 分析：区间内的情绪分布、负面占比、触发词、时段分布。
 */
export function affectReport({ store, range = 'day' }) {
  const days = RANGE_DAYS[range] ?? 1
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

  const byLabel = Object.fromEntries(
    store.db
      .prepare('SELECT label, COUNT(*) AS n FROM affect_events WHERE occurred_at >= ? GROUP BY label')
      .all(since)
      .map((r) => [r.label, r.n]),
  )
  const total = Object.values(byLabel).reduce((a, b) => a + b, 0)
  const negative = (byLabel.negative ?? 0) + (byLabel.urgent ?? 0)

  const triggerRows = store.db
    .prepare('SELECT triggers FROM affect_events WHERE occurred_at >= ?')
    .all(since)
  const triggerSum = new Map()
  for (const row of triggerRows) {
    let words = []
    try {
      words = JSON.parse(row.triggers || '[]')
    } catch {
      words = []
    }
    if (!Array.isArray(words)) continue
    for (const word of words) {
      if (!word) continue
      triggerSum.set(word, (triggerSum.get(word) ?? 0) + 1)
    }
  }
  const topTriggers = [...triggerSum.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word, n]) => ({ word, n }))

  const byHour = store.db
    .prepare("SELECT substr(occurred_at, 12, 2) AS hour, COUNT(*) AS n FROM affect_events WHERE occurred_at >= ? GROUP BY hour ORDER BY hour")
    .all(since)
    .map((r) => ({ hour: r.hour, n: r.n }))

  return {
    range,
    since,
    total,
    byLabel,
    negativeRatio: total ? Math.round((negative / total) * 100) / 100 : 0,
    topTriggers,
    byHour,
  }
}
