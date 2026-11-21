/**
 * selfcheck.mjs — 30 秒自检（每周配合用）。
 *   node tools/selfcheck.mjs            # 用默认数据目录
 *   node tools/selfcheck.mjs --dir D:\...\dsh-memory-data
 *   node tools/selfcheck.mjs --quick    # 只打印最后 3 行
 *
 * 退出码：0 健康 / 1 失败（不变量不一致、库打不开）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import MemoryStore from '../lib/memory/store.js'

const argv = process.argv.slice(2)
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null
const quick = argv.includes('--quick')

/** 数据目录解析：--dir > 环境变量 > 交接包里的 sibling「数据」 > 仓库旁的 dsh-memory-data。 */
function resolveDataDir() {
  if (dirArg) return path.resolve(dirArg)
  if (process.env.DSH_MEMORY_DATA_DIR) return path.resolve(process.env.DSH_MEMORY_DATA_DIR)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const port = path.resolve(here, '..', '..', '..', '数据') // 交接包布局：代码/dsh-memory-core/tools → 包根/数据
  if (fs.existsSync(port)) return port
  return path.resolve(here, '..', '..', 'dsh-memory-data') // 仓库布局：dsh-memory-core/tools → 仓库旁
}
const dataDir = resolveDataDir()

const lines = []
function say(text) {
  console.log(text)
  lines.push(text)
}

say(`memory-core 自检  ${new Date().toLocaleString('sv-SE')}`)
say(`数据目录 ${dataDir}`)

if (!fs.existsSync(dataDir)) {
  say('结果 FAIL：数据目录不存在（还没建库，或路径不对）')
  process.exit(1)
}

let store
try {
  store = new MemoryStore({ dataDir }).open()
} catch (error) {
  say(`结果 FAIL：库打不开 —— ${error?.message ?? error}`)
  process.exit(1)
}

let code = 0
try {
  const stats = store.stats()
  const inv = store.checkInvariants()
  const backups = fs.existsSync(path.join(dataDir, 'backup')) ? fs.readdirSync(path.join(dataDir, 'backup')).length : 0
  const wal = fs.existsSync(path.join(dataDir, 'db', 'memory.db-wal'))
    ? fs.statSync(path.join(dataDir, 'db', 'memory.db-wal')).size
    : 0

  say(`权威源 ${stats.authority}   schema v${stats.schemaVersion}`)
  say(`记录 ${stats.records} 条（active ${stats.active} / pending ${stats.pending} / quarantined ${stats.quarantined} / rejected ${stats.rejected} / S 级 ${stats.sLevel}）  FTS ${stats.fts} 行`)
  say(`已评分 ${stats.scored} 条   分层 ${stats.byLayer.map((r) => `${r.layer}:${r.n}`).join(' ') || '（空）'}`)
  say(`索引与主表：${inv.ok ? '一致' : `不一致（缺索引 ${inv.missingFts.length} / 哈希不符 ${inv.hashMismatch.length} / 孤儿索引 ${inv.orphanFts.length}）`}`)
  say(`快照 ${backups} 份   WAL ${wal} 字节`)
  if (!inv.ok) {
    code = 1
    say('结果 FAIL：索引与主表不一致，请先修索引再写入（方案 §60：阻断写入并告警）')
  } else {
    say('结果 OK')
  }
} finally {
  store.close()
}

if (quick && lines.length > 4) {
  console.log('---')
  console.log(lines.slice(-3).join('\n'))
}
process.exit(code)
