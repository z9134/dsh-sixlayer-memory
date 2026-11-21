/** p28：点一个圆点 → 这一条记忆的全部详情 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { readDetail } from '../lib/memory/detail.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ' + name) } else { fail += 1; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p28-'))
const store = new MemoryStore({ dataDir: dir }).open()

const a = store.write({
  content: 'USB 摄像头卡死的软件复位（2026-10-26 实测有效，免拔插）：停掉进程再拉起来就好。',
  layer: 'L2',
  sourceChannel: 'user',
  tags: ['摄像头', '排障'],
  summary: '★ USB 摄像头卡死的软件复位（2026-10-26 实测有效，免拔插）：症状是 CPU 烧满。',
})
const b = store.write({
  content: '摄像头采集用 ffmpeg，帧率 30。',
  layer: 'L2',
  sourceChannel: 'user',
  tags: ['摄像头'],
})
ok('准备：两条记录都 active', a.status === 'active' && b.status === 'active')

// ---------- 详情：核心字段 ----------
const d = readDetail({ store, recordId: a.record_id })
ok('详情：能取到', d && d.record_id === a.record_id)
ok('详情：带正文（不是摘要）', typeof d.content === 'string' && d.content.includes('停掉进程'), String(d.content).slice(0, 30))
ok('详情：带标签', Array.isArray(d.tags) && d.tags.includes('摄像头') && d.tags.includes('排障'), JSON.stringify(d.tags))
ok('详情：带人话标题', d.display && d.display.title.includes('USB 摄像头'), JSON.stringify(d.display && d.display.title))
ok('详情：类别是修过的坑', d.display.kind === '修过的坑', d.display.kind)
ok('详情：带层级/信任/来源，够画元信息表', d.layer === 'L2' && d.trust_level === 'trusted' && d.source_channel === 'user')
ok('详情：相关记忆是数组', Array.isArray(d.neighbors), JSON.stringify(d.neighbors))
ok('详情：同标签的记忆被连上', d.neighbors.length >= 1 && d.neighbors.some((n) => n.record_id === b.record_id), JSON.stringify(d.neighbors))
ok('详情：相关记忆带人话标题', d.neighbors.every((n) => typeof n.title === 'string' && n.title.length > 0))
ok('详情：相关记忆带理由', d.neighbors.every((n) => Array.isArray(n.reasons)))

// ---------- 边界 ----------
ok('详情：不存在的记录返回 null', readDetail({ store, recordId: 'NOPE' }) === null)
ok('详情：空 id 返回 null', readDetail({ store, recordId: '' }) === null)

const secret = store.write({ content: '生产库密码：Hunter2-prod', layer: 'L3', sourceChannel: 'user' })
ok('准备：凭证记录判 S', secret.sad_level === 'S')
const denied = readDetail({ store, recordId: secret.record_id })
ok('详情：S 级默认不给正文', denied && denied.denied === true && denied.content === undefined, JSON.stringify(denied).slice(0, 80))
ok('详情：S 级仍然有人话标题', denied.display && typeof denied.display.title === 'string' && denied.display.title.length > 0)
const allowed = readDetail({ store, recordId: secret.record_id, includeSensitive: true })
ok('详情：显式授权后才给正文', typeof allowed.content === 'string' && allowed.content.includes('Hunter2'))

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\nP28 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
