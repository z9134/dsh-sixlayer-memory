/** p8：认知层第一增量（情绪标注 + 联想）验收 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { analyzeAffect, initialImportance } from '../lib/memory/emotion.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// 0 纯函数
const neg = analyzeAffect('那个插件崩溃了，一直报错，太烦了，紧急！')
const pos = analyzeAffect('修好了，测试全部通过，感谢')
const neu = analyzeAffect('今天的会议改到下午三点')
ok('负面被识别', neg.label === 'urgent' || neg.label === 'negative', neg.label)
ok('负面效价 < 0', neg.valence < 0, String(neg.valence))
ok('正面效价 > 0', pos.valence > 0, String(pos.valence))
ok('中性不误判', neu.label === 'neutral', neu.label)
ok('重要性落在 0..1', initialImportance(neg, 'L2') >= 0 && initialImportance(neg, 'L2') <= 1)
ok('L2 重要性高于 L1', initialImportance(pos, 'L2') > initialImportance(pos, 'L1'))

// 1 迁移 + 写入 + 联想
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p8-'))
fs.mkdirSync(path.join(dir, 'db'), { recursive: true })
fs.copyFileSync('D:/001/CH002/dsh-memory-data/db/memory.db', path.join(dir, 'db', 'memory.db'))
const store = new MemoryStore({ dataDir: dir, authority: 'shadow' }).open()
ok('schema 迁移到 v9', store.getMeta('schema_version') === '9', String(store.getMeta('schema_version')))
const cols = store.db.prepare('PRAGMA table_info(records)').all().map((c) => c.name)
ok('有 affect_label 列', cols.includes('affect_label'))
ok('有 importance 列', cols.includes('importance'))

const w = store.write({ content: '插件崩溃了，一直报错，紧急处理！', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })
const row = store.db.prepare('SELECT affect_label, affect_valence, affect_arousal, importance FROM records WHERE record_id = ?').get(w.record_id)
ok('写入带情绪标签', row.affect_label === 'urgent' || row.affect_label === 'negative', row.affect_label)
ok('写入带效价', typeof row.affect_valence === 'number' && row.affect_valence < 0, String(row.affect_valence))
ok('写入带重要性', typeof row.importance === 'number' && row.importance > 0.5, String(row.importance))

const w2 = store.write({ content: '记忆底座修好了，测试全部通过，感谢', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })
const a = store.associate({ recordId: w2.record_id, topK: 5 })
ok('联想返回结构', a && Array.isArray(a.items))
ok('联想有理由', a.items.length === 0 || a.items.every((i) => Array.isArray(i.reasons) && i.reasons.length > 0))
const aq = store.associate({ query: '崩溃 报错', topK: 5 })
ok('纯文本也能联想', Array.isArray(aq.items))

store.close()
console.log(`\nP8 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
