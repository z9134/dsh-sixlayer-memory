/** p15：「一切皆零件」——零件清单与装配 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { listParts, compose, PARTS } from '../lib/parts/index.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p15-'))
const store = new MemoryStore({ dataDir: dir }).open()
store.write({ content: '用户偏好：回答要短，先给结论再给理由', layer: 'L1', sourceChannel: 'user', trustLevel: 'trusted', tags: ['profile'] })
store.write({ content: '插件崩溃是因为 BOM，以后写 JSON 一律用 Node', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['scene:deploy'] })
store.write({ content: '今天的会议改到下午三点', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })

const parts = listParts()
ok('零件数量 5', parts.length === 5, String(parts.length))
ok('零件有版本与说明', parts.every((p) => p.version === 1 && p.describe.length > 0))

const pack = compose(store, {})
ok('默认装配非空', pack.text.length > 0)
ok('默认含 profile/lessons/recent 三块', ['profile','lessons','recent'].every((n) => pack.parts.some((b) => b.name === n)))

const scenePack = compose(store, { scene: 'deploy', parts: ['scene'] })
ok('scene 零件命中', scenePack.text.includes('BOM') || scenePack.text.includes('崩溃'), scenePack.text)

const assocPack = compose(store, { seed: '崩溃', parts: ['associations'] })
ok('associations 零件可跑', Array.isArray(assocPack.parts) && assocPack.parts[0].name === 'associations')

const unknown = compose(store, { parts: ['nope'] })
ok('未知零件被跳过并标注', unknown.parts[0].lines[0].includes('未知零件'))

const tiny = compose(store, { parts: ['profile','recent'], maxChars: 100 })
ok('预算生效', tiny.text.length <= 140, String(tiny.text.length))

ok('零件可枚举', Object.keys(PARTS).join(',') === 'profile,recent,lessons,scene,associations')

store.close()
console.log(`\nP15 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
