/** p24：文本账本 + 每日健康一行 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { ledgerInit, ledgerSync, ledgerVerify, healthLine } from '../lib/memory/ledger.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p24-'))
const store = new MemoryStore({ dataDir: dir }).open()

const a = store.write({ content: '账本测试甲', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['ledger'] })
const b = store.write({ content: '账本测试乙', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['ledger'] })

let threw = false
try { ledgerVerify({ store }) } catch { threw = true }
ok('未初始化时 verify 报错', threw)

const init = ledgerInit({ store })
ok('init 拍到 2 条', init.initialized === 2, JSON.stringify(init))
const c = store.write({ content: '账本测试丙（新增）', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['ledger'] })
const sync = ledgerSync({ store })
ok('sync 只补新记录', sync.added === 1 && sync.total === 3, JSON.stringify(sync))
ok('verify 通过', ledgerVerify({ store }).ok === true)

store.db.prepare('UPDATE records SET content = ? WHERE record_id = ?').run('账本测试乙（被篡改）', b.record_id)
const bad = ledgerVerify({ store })
ok('篡改被检出', bad.ok === false && bad.changed.includes(b.record_id), JSON.stringify(bad.changed))

const line = healthLine({ store })
ok('健康一行有 ledger=FAIL', line.includes('ledger=FAIL'), line)
ok('健康一行含计数', line.includes('total=3'), line)

store.close()
console.log(`\nP24 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)