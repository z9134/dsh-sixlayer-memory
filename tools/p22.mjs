/** p22：时间轴（按天分组情绪事件与记忆） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { timeline } from '../lib/memory/timeline.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p22-'))
const store = new MemoryStore({ dataDir: dir }).open()

const now = Date.now()
const ins = store.db.prepare(`INSERT INTO affect_events (event_id, session_id, source, occurred_at, label, valence, arousal, excerpt, excerpt_hash, triggers, created_at) VALUES (?, 's', 'qq', ?, ?, 0, 0, ?, ?, '[]', ?)`)
ins.run('t1', new Date(now - 3600 * 1000).toISOString(), 'negative', '今天有点难过', 'h1', new Date().toISOString())
ins.run('t2', new Date(now - 2 * 3600 * 1000).toISOString(), 'positive', '后来搞定了', 'h2', new Date().toISOString())
store.write({ content: '时间轴测试：一条记忆', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['timeline'] })

const t = timeline({ store, days: 7 })
ok('有日期分组', Array.isArray(t.groups) && t.groups.length >= 1, String(t.groups.length))
const g = t.groups[0]
ok('情绪条目数', g.affect.length === 2, String(g.affect.length))
ok('情绪带中文标签', g.affect[0].labelCn === '负面' || g.affect[1].labelCn === '负面', JSON.stringify(g.affect.map(a => a.labelCn)))
ok('记忆条目存在', g.memories.length === 1, String(g.memories.length))
ok('日期格式', /^\d{4}-\d{2}-\d{2}$/.test(g.date), g.date)

store.close()
console.log(`\nP22 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)