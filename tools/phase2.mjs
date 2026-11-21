/**
 * phase2.mjs — 二期回归（记录仪 + 导入 + 影子读 + 审计）。
 *   node tools/phase2.mjs
 * 用临时库与临时"旧记忆目录"，不动真实数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { Recorder } from '../lib/memory/recorder.js'

let pass = 0
let fail = 0
const out = []
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    out.push(`  PASS  ${label}`)
  } else {
    fail += 1
    out.push(`  FAIL  ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

// ---------- 造一个假的"旧记忆"目录 ----------
const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-legacy-'))
fs.mkdirSync(path.join(legacyHome, 'runtime'), { recursive: true })
fs.mkdirSync(path.join(legacyHome, 'documents', 'active'), { recursive: true })

fs.writeFileSync(
  path.join(legacyHome, 'runtime', 'memories.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        { content: '板子风扇阈值 60℃ 升档、55℃ 降档，实测空载 55-57℃。', target: 'memory', importance: 'normal', created_at: '2026-10-01T00:00:00Z' },
        { content: '开发板 SSH 密码：Abc123456，串口 COM8 115200。', target: 'memory', importance: 'critical', created_at: '2026-10-02T00:00:00Z' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(
  path.join(legacyHome, 'documents', 'active', 'ip-wifi-ssh-vnc.md'),
  [
    '# 设备凭证',
    '',
    '| SSID | 密码 | 用途 |',
    '|---|---|---|',
    '| CALP | `ch1949101` | 当前 |',
    '',
    'SSH root/Mind@123，VNC 5900/aipro2026',
    '',
  ].join('\n'),
  'utf8',
)

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p2-'))
const store = new MemoryStore({ dataDir, authority: 'shadow' }).open()

try {
  // ---------- 1. 记录仪基础 ----------
  const w = store.write({ content: '二期联调：记录仪写入一条测试记录。', layer: 'L1', sourceChannel: 'user' })
  check('写入成功并返回 record_id', Boolean(w.record_id) && w.status === 'active', JSON.stringify(w))

  const inv = store.checkInvariants()
  check('二期后不变量仍一致', inv.ok === true, JSON.stringify(inv))

  const audit1 = store.audit({ deep: true })
  check('记录仪：写入后哈希链一致', audit1.ok === true, JSON.stringify(audit1.broken_at))
  check('记录仪：产生了 trace 行', audit1.lines >= 1 && audit1.files >= 1, JSON.stringify({ lines: audit1.lines, files: audit1.files }))

  // ---------- 2. 禁记：查询里的口令不得落盘 ----------
  store.search({ query: '密码是 TopSecret999 的记录', topK: 3 })
  const auditFile = fs
    .readdirSync(path.join(dataDir, 'audit'))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dataDir, 'audit', f))[0]
  const auditText = fs.readFileSync(auditFile, 'utf8')
  check('禁记：查询明文不落盘', !auditText.includes('TopSecret999'), '发现明文口令')
  check('禁记：留了脱敏占位', auditText.includes('«REDACTED:'), '没有脱敏标记')
  check('禁记：存了查询哈希', /"query_hash":"[0-9a-f]{64}"/.test(auditText), '缺 query_hash')

  // ---------- 3. 断链能被查出来 ----------
  const lines = auditText.trimEnd().split('\n')
  const first = JSON.parse(lines[0])
  first.payload.op = 'tampered'
  lines[0] = JSON.stringify(first)
  fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf8')
  const audit2 = store.audit({ deep: true })
  check('篡改一行 → deep 校验报断链', audit2.ok === false && Boolean(audit2.brokenAt), JSON.stringify(audit2.broken_at))

  // 恢复现场（后续用例需要正常链）
  fs.unlinkSync(auditFile)
  const stateFile = path.join(dataDir, 'audit', '.state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ seq: 0, hash: 'GENESIS' }), 'utf8')
  store.recorder.state = { seq: 0, hash: 'GENESIS' }

  // ---------- 4. 导入：只读 + 脱敏 + 幂等 ----------
  const imp1 = store.importLegacy({ home: legacyHome })
  check('导入：扫到 2 条记忆 + 1 份文档', imp1.scanned.memory === 2 && imp1.scanned.documents === 1, JSON.stringify(imp1.scanned))
  check('导入：3 条全部入库', imp1.imported === 3 && imp1.errors.length === 0, JSON.stringify({ imported: imp1.imported, errors: imp1.errors }))
  check('导入：2 条被判 S 级', imp1.redacted === 2, JSON.stringify(imp1.redacted_kinds))

  const dbText = JSON.stringify(store.db.prepare('SELECT content FROM records').all())
  check('导入：库里没有明文口令', !dbText.includes('Abc123456') && !dbText.includes('Mind@123') && !dbText.includes('ch1949101'), '发现明文')
  check('导入：留了脱敏占位', dbText.includes('«REDACTED:'))

  check('导入：凭证文档只导指针（不导正文）', (imp1.pointer_only ?? 0) >= 1, JSON.stringify({ pointer_only: imp1.pointer_only }))
  const docRow = store.db.prepare("SELECT content FROM records WHERE legacy_ref LIKE 'documents/%'").get()
  check('导入：指针记录里没有正文', Boolean(docRow) && docRow.content.length < 400 && docRow.content.includes('【指针】'), JSON.stringify(docRow)?.slice(0, 120))

  const imp2 = store.importLegacy({ home: legacyHome })
  check('导入：二次执行幂等（imported=0）', imp2.imported === 0 && imp2.skipped === 3, JSON.stringify({ imported: imp2.imported, skipped: imp2.skipped }))

  const dry = store.importLegacy({ home: legacyHome, dryRun: true })
  check('导入：dry_run 不写库', dry.dry_run === true && dry.imported === 0 && dry.skipped === 3, JSON.stringify(dry))

  // ---------- 5. 影子读 ----------
  const shadow = store.shadow({ query: '风扇阈值 温度', topK: 5, home: legacyHome })
  check('影子读：两路都有结果', shadow.legacy.length >= 1 && shadow.mine.length >= 1, JSON.stringify({ legacy: shadow.legacy.length, mine: shadow.mine.length }))
  check('影子读：旧库命中能在新库找到（一致）', shadow.consistent === true, JSON.stringify(shadow.diff))

  // ---------- 6. 回放 ----------
  const recent = store.audit({}).recent[0]
  check('回放：能拿到最近一条 trace', Boolean(recent?.trace_id), JSON.stringify(recent))
  const trace = store.traceLookup(recent.trace_id)
  check('回放：按 trace_id 取回详情', Boolean(trace) && trace.trace_id === recent.trace_id && Array.isArray(trace.hits), JSON.stringify(trace)?.slice(0, 160))

  // ---------- 7. 滚动 ----------
  const oldFile = path.join(dataDir, 'audit', 'audit-202001.jsonl')
  fs.writeFileSync(oldFile, '{"payload":{"seq":0},"prev":"GENESIS","hash":"x"}\n', 'utf8')
  const longAgo = new Date(Date.now() - 200 * 86400_000)
  fs.utimesSync(oldFile, longAgo, longAgo)
  const pruned = store.recorder.prune()
  check('滚动：超过 90 天的文件被清掉', !fs.existsSync(oldFile), JSON.stringify(pruned.removed))
} finally {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(legacyHome, { recursive: true, force: true })
}

// ---------- 8. Recorder 单独：空目录也能开 ----------
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-rec-'))
try {
  const rec = new Recorder({ dir: emptyDir }).open()
  const r1 = rec.record({ op: 'test', note: 'hello' })
  const v = rec.verify({ deep: true })
  check('Recorder：空目录可开、可写、可验', v.ok === true && v.lines === 1 && r1.seq === 1, JSON.stringify(v))
  rec.close?.()
} finally {
  fs.rmSync(emptyDir, { recursive: true, force: true })
}

console.log(out.join('\n'))
console.log(`\n${fail === 0 ? 'PHASE2 OK' : 'PHASE2 FAILED'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
