/** p20：情绪日报/周报 + 尖峰提醒（二期/三期） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { buildAffectReportText, saveAffectReport } from '../lib/memory/affect-report.js'
import { affectSpike, affectHint, notifyAffectSpike } from '../lib/memory/affect-alert.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p20-'))
const store = new MemoryStore({ dataDir: dir }).open()

function addEvent(minAgo, label) {
  store.db.prepare(`INSERT INTO affect_events (event_id, session_id, source, occurred_at, label, valence, arousal, excerpt, excerpt_hash, triggers, created_at)
    VALUES (?, 's1', 'qq', ?, ?, 0, 0, 'demo', ?, '[]', ?)`).run(
    'e_' + label + '_' + minAgo,
    new Date(Date.now() - minAgo * 60000).toISOString(),
    label,
    'h' + minAgo,
    new Date().toISOString(),
  )
}

addEvent(10, 'negative')
addEvent(20, 'negative')
addEvent(30, 'positive')

const spike = affectSpike(store, { hours: 3, threshold: 2 })
ok('检测到尖峰', spike.spike === true && spike.count === 2, JSON.stringify(spike))
ok('提示文本非空', affectHint(store, { hours: 3, threshold: 2 }).includes('情绪提示'))

const report = (await import('../lib/memory/affect-events.js')).affectReport({ store, range: 'day' })
const text = buildAffectReportText(report)
ok('报告含标题', text.includes('# 情绪日报'))
ok('报告含分布', text.includes('分布'))
ok('报告含触发词段', text.includes('高频触发词') || report.topTriggers.length === 0)

const saved = saveAffectReport({ store, dataDir: dir, range: 'day' })
ok('报告落盘', fs.existsSync(saved.path), saved.path)
ok('落盘内容一致', fs.readFileSync(saved.path, 'utf8').includes('情绪日报'))

let sent = 0
const first = await notifyAffectSpike({ store, notify: async () => { sent += 1 }, options: { hours: 3, threshold: 2 } })
ok('首次通知发送', first.sent === true && sent === 1, JSON.stringify(first))
const second = await notifyAffectSpike({ store, notify: async () => { sent += 1 }, options: { hours: 3, threshold: 2 } })
ok('冷却期内不重复', second.sent === false && second.reason === 'cooldown', JSON.stringify(second))

store.close()
console.log(`\nP20 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)