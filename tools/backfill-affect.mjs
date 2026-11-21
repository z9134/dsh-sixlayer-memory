/**
 * backfill-affect.mjs — 给存量记忆补情绪标签与重要性。
 *
 * 背景：情绪标注是 v7 才加的，之前的记录 affect_label 都是 NULL/neutral，
 * 观测页的情绪分布和趋势因此没有历史数据。
 *
 * 安全：
 *   1. 先 VACUUM INTO 备份整库（备份失败就中止）
 *   2. 只改 affect_* 与 importance，不动 content/summary/status
 *   3. 写一条 op=affect.backfill 的审计
 *   4. --dry 只统计不写库
 */
import fs from 'node:fs'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { analyzeAffect, initialImportance } from '../lib/memory/emotion.js'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const dataDir = argv.find((a) => !a.startsWith('--')) ?? 'D:/001/CH002/dsh-memory-data'

const store = new MemoryStore({ dataDir }).open()

// 1. 备份
const backupDir = path.join(dataDir, 'backup')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupPath = path.join(backupDir, `affect-backfill-${stamp}.db`)
if (!dry) {
  store.db.exec(`VACUUM INTO '${backupPath.replace(/\\/g, '/')}'`)
  console.log('备份：' + backupPath + ' (' + fs.statSync(backupPath).size + ' bytes)')
}

// 2. 逐条重算
const rows = store.db
  .prepare("SELECT record_id, layer, summary, content, affect_label FROM records WHERE status IN ('active','pending')")
  .all()

const counts = { total: rows.length, changed: 0, neutral: 0, positive: 0, negative: 0, urgent: 0 }
const updates = []
for (const row of rows) {
  const affect = analyzeAffect(`${row.summary ?? ''} ${row.content ?? ''}`)
  const importance = initialImportance(affect, row.layer)
  const same = row.affect_label === affect.label
  if (same) {
    if (affect.label === 'neutral') counts.neutral += 1
    else counts[affect.label] += 1
    continue
  }
  counts.changed += 1
  counts[affect.label] = (counts[affect.label] ?? 0) + 1
  updates.push({
    record_id: row.record_id,
    label: affect.label,
    valence: affect.valence,
    arousal: affect.arousal,
    importance,
  })
}

if (!dry && updates.length > 0) {
  const stmt = store.db.prepare(
    'UPDATE records SET affect_label = ?, affect_valence = ?, affect_arousal = ?, importance = ?, updated_at = ? WHERE record_id = ?',
  )
  const now = new Date().toISOString()
  store.db.exec('BEGIN')
  try {
    for (const u of updates) stmt.run(u.label, u.valence, u.arousal, u.importance, now, u.record_id)
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }
  store.record({
    op: 'affect.backfill',
    count: updates.length,
    detail: counts,
  })
}

console.log(JSON.stringify({ dry, ...counts }, null, 2))
store.close()
