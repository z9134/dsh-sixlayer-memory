/** p11：QQ 桥（命令解析、白名单、写入闸门） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { QqBridge, parseCommand, segmentsToText } from '../lib/memory/qq.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// 0 纯函数
ok('中文记命令', JSON.stringify(parseCommand('/记 你好')) === JSON.stringify({ cmd: 'remember', arg: '你好' }))
ok('英文 search', parseCommand('/search 崩溃')?.cmd === 'search')
ok('非命令返回 null', parseCommand('你好') === null)
ok('未知命令', parseCommand('/xyz')?.cmd === 'unknown')
ok('帮助别名', parseCommand('/?')?.cmd === 'help')
const seg = segmentsToText([{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' /记 你好' } }])
ok('消息段拼接', seg.includes('/记 你好'), seg)

// 1 命令处理
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p11-'))
const store = new MemoryStore({ dataDir: dir }).open()
const bridge = new QqBridge({ store, config: { enabled: true, allowedUsers: ['123'] } })

const r1 = await bridge.handleCommand(parseCommand('/记 明天下午三点开会'), { userId: '123' })
ok('记命令返回已记下', r1.includes('已记下') || r1.includes('已存在'), r1)
const row = store.db.prepare("SELECT status, pending_review, source_channel FROM records ORDER BY created_at DESC LIMIT 1").get()
ok('QQ 写入走未验证闸门', row.status === 'pending' && row.pending_review === 1, JSON.stringify(row))
ok('来源记为 qq', row.source_channel === 'qq', row.source_channel)

const r2 = await bridge.handleCommand(parseCommand('/搜 开会'), { userId: '123' })
ok('搜索有回复', r2.includes('搜到') || r2.includes('没搜到'), r2)
const r3 = await bridge.handleCommand(parseCommand('/状态'), {})
ok('状态含记录数', r3.includes('记录'), r3)
const r4 = await bridge.handleCommand(parseCommand('/联想 开会'), {})
ok('联想有回复', r4.includes('联想到') || r4.includes('没想到'), r4)
const r5 = await bridge.handleCommand(parseCommand('/帮助'), {})
ok('帮助列出命令', r5.includes('/记'), r5)

// 2 白名单：未授权用户被忽略且不写库
const before = store.db.prepare('SELECT COUNT(*) n FROM records').get().n
await bridge._handleEvent({ post_type: 'message', message_type: 'private', self_id: '999', user_id: '888', message: [{ type: 'text', data: { text: '/记 不该写进去' } }] })
const after = store.db.prepare('SELECT COUNT(*) n FROM records').get().n
ok('白名单外不写库', before === after, `${before} -> ${after}`)
ok('白名单外计数 ignored', bridge.stats.ignored >= 1, String(bridge.stats.ignored))

store.close()
console.log(`\nP11 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
