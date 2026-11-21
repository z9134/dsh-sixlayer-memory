/**
 * ledger.js — 文本账本（补齐自《记忆系统实施单》5.2）。
 *
 * 作用：给每条记忆记一份指纹，证明"没丢过、没被改过"。
 * 与审计链的区别：审计链管"操作顺序不可篡改"，账本管"每条正文的指纹"。
 *
 * 纪律：
 *   - init：只拍一次快照
 *   - sync：只补新 id，老记录绝不覆盖
 *   - verify：账本里每个 id 必须仍在库中且哈希一致，否则报错
 *   - 顺序：先 sync 再 verify（反过来会把新记忆误报成丢失）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FILE = 'ledger.json'

function filePath(dataDir) {
  return path.join(dataDir, FILE)
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function readLedger(dataDir) {
  const file = filePath(dataDir)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeLedger(dataDir, data) {
  const file = filePath(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

export function ledgerInit({ store }) {
  const rows = store.db.prepare("SELECT record_id, content FROM records WHERE status = 'active'").all()
  const records = {}
  for (const row of rows) records[row.record_id] = { sha256: sha256(row.content), len: String(row.content ?? '').length }
  writeLedger(store.dataDir, { version: 1, created_at: new Date().toISOString(), records })
  return { initialized: rows.length, path: filePath(store.dataDir) }
}

export function ledgerSync({ store }) {
  const ledger = readLedger(store.dataDir)
  if (!ledger) throw new Error('账本不存在：先执行 init')
  const rows = store.db.prepare("SELECT record_id, content FROM records WHERE status = 'active'").all()
  let added = 0
  for (const row of rows) {
    if (ledger.records[row.record_id]) continue
    ledger.records[row.record_id] = { sha256: sha256(row.content), len: String(row.content ?? '').length }
    added += 1
  }
  ledger.synced_at = new Date().toISOString()
  writeLedger(store.dataDir, ledger)
  return { added, total: Object.keys(ledger.records).length }
}

export function ledgerVerify({ store }) {
  const ledger = readLedger(store.dataDir)
  if (!ledger) throw new Error('账本不存在：先执行 init')
  const ids = Object.keys(ledger.records)
  const missing = []
  const changed = []
  const get = store.db.prepare('SELECT content FROM records WHERE record_id = ?')
  for (const id of ids) {
    const row = get.get(id)
    if (!row) {
      missing.push(id)
      continue
    }
    const now = sha256(row.content)
    if (now !== ledger.records[id].sha256) changed.push(id)
  }
  return {
    ok: missing.length === 0 && changed.length === 0,
    total: ids.length,
    missing,
    changed,
  }
}

/** 每日健康一行（补齐自实施单 5.3）。 */
export function healthLine({ store }) {
  const stats = store.stats()
  let ledger = 'MISSING'
  try {
    const v = ledgerVerify({ store })
    ledger = v.ok ? 'OK' : `FAIL(missing=${v.missing.length},changed=${v.changed.length})`
  } catch {
    ledger = 'MISSING'
  }
  const pending = stats.pending ?? 0
  const day = new Date().toISOString().slice(0, 10)
  return `[memory] ${day} total=${stats.records} active=${stats.active} s=${stats.sLevel} pending=${pending} ledger=${ledger} audit=${stats.audit?.ok ? 'OK' : 'FAIL'}`
}
