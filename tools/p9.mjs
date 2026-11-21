/** p9：B2 注入情绪加权 + B3 关联提示 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { selectSnapshot, Injector } from '../lib/memory/inject.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p9-'))
const store = new MemoryStore({ dataDir: dir }).open()

const neutral = store.write({ content: '今天的会议改到下午三点', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['meeting'] })
const negative = store.write({ content: '插件崩溃了，一直报错，紧急！', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['crash'] })
store.write({ content: '崩溃的线索：错误码 500 出现在网关', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['crash'] })
const secret = store.write({ content: '崩溃现场的密钥 sk-test-123', layer: 'L2', sadLevel: 'S', sourceChannel: 'user', trustLevel: 'trusted', tags: ['crash'] })

const rows = selectSnapshot(store, { maxRecords: 10 })
const idxNeg = rows.findIndex((r) => r.record_id === negative.record_id)
const idxNeu = rows.findIndex((r) => r.record_id === neutral.record_id)
ok('负面高唤醒排在前面', idxNeg >= 0 && idxNeu >= 0 && idxNeg < idxNeu, `neg=${idxNeg} neu=${idxNeu}`)
ok('S 级不进注入池', !rows.some((r) => r.record_id === secret.record_id))

const injector = new Injector({ store, maxRecords: 3, maxChars: 2000 })
const text = injector.text()
ok('注入文本非空', text.length > 0)
ok('注入带关联行', text.includes('> 关联：'), text.slice(0, 300))
ok('关联不带 S 正文', !text.includes('sk-test-123'))

store.close()
console.log(`\nP9 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
