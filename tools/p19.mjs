/** p19：情绪事件采集（多帧 zstd 解析、type/kind 过滤、去重、报告） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import MemoryStore from '../lib/memory/store.js'
import { decodeZstdFrames, extractUserMessages, ingestQqSessions, affectReport } from '../lib/memory/affect-events.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p19-'))
const sessions = path.join(root, 'sessions')
const ws = path.join(sessions, '--x-dsh-qqbot-workspace--')
const sess = path.join(ws, 'session-test-1')
fs.mkdirSync(sess, { recursive: true })

const events = [
  { type: 'session', version: 4, id: 'session-test-1', createdAt: Date.now(), cwd: 'C:/x/.dsh-qqbot/workspace' },
  { type: 'user/message', time: Date.now() - 3000, data: { content: [{ type: 'text', text: '我现在心情有点难过' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', time: Date.now() - 2000, data: { content: [{ type: 'text', text: '今天测试全部通过，开心' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', time: Date.now() - 1000, data: { content: [{ type: 'text', text: 'Current runtime context. 注入内容' }], source: { kind: 'runtime-context' }, role: 'user' } },
]
const frame1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(events[0]) + '\n', 'utf8'))
const frame2 = zlib.zstdCompressSync(Buffer.from(events.slice(1).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
fs.writeFileSync(path.join(sess, 'session.v4.jsonl.zstd'), Buffer.concat([frame1, frame2]))

const decoded = decodeZstdFrames(fs.readFileSync(path.join(sess, 'session.v4.jsonl.zstd')))
ok('多帧解压', decoded.includes('session-test-1') && decoded.includes('难过'), String(decoded.length))
const messages = extractUserMessages(decoded)
ok('只收 user 消息', messages.length === 2, String(messages.length))

const store = new MemoryStore({ dataDir: path.join(root, 'db') }).open()
const first = ingestQqSessions({ store, sessionsRoot: sessions, limit: 5 })
ok('首次采集 2 条', first.added === 2, JSON.stringify(first))
ok('负面 1 正面 1', first.labels.negative === 1 && first.labels.positive === 1, JSON.stringify(first.labels))
const second = ingestQqSessions({ store, sessionsRoot: sessions, limit: 5 })
ok('重复采集去重', second.added === 0 && second.skipped === 2, JSON.stringify(second))

const report = affectReport({ store, range: 'day' })
ok('报告事件数', report.total === 2, JSON.stringify(report.byLabel))
ok('负面占比 0.5', report.negativeRatio === 0.5, String(report.negativeRatio))
ok('触发词有难过/开心', report.topTriggers.some((t) => t.word === '难过') && report.topTriggers.some((t) => t.word === '开心'), JSON.stringify(report.topTriggers))
ok('有小时分布', Array.isArray(report.byHour) && report.byHour.length > 0)

store.close()
console.log(`\nP19 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)