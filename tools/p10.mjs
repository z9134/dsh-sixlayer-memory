/** p10：B4 情绪趋势（近 14 天按天聚合） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p10-'))
const store = new MemoryStore({ dataDir: dir }).open()
store.write({ content: '插件崩溃了，一直报错，紧急！', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })
store.write({ content: '修好了，测试全部通过，感谢', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })
store.write({ content: '今天的会议改到下午三点', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })

const trendDays = 14
const trendSince = new Date(Date.now() - (trendDays - 1) * 24 * 3600 * 1000).toISOString().slice(0, 10)
const raw = store.db.prepare(
  `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
          SUM(CASE WHEN affect_label IN ('negative','urgent') THEN 1 ELSE 0 END) AS bad,
          SUM(CASE WHEN affect_label = 'positive' THEN 1 ELSE 0 END) AS good
     FROM records WHERE status='active' AND substr(created_at,1,10) >= ? GROUP BY day`,
).all(trendSince)
const today = new Date().toISOString().slice(0, 10)
const row = raw.find((r) => r.day === today)
ok('今天有数据', Boolean(row), JSON.stringify(raw))
ok('今天 3 条', row?.n === 3, String(row?.n))
ok('负面 1 条', row?.bad === 1, String(row?.bad))
ok('正面 1 条', row?.good === 1, String(row?.good))
ok('趋势窗口 14 天', trendDays === 14)

store.close()
console.log(`\nP10 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
