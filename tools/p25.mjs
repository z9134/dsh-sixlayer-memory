/** p25：每轮记忆生命周期（自动召回 / 候选沉淀 / 用进强化） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import {
  attachLifecycle,
  buildRecallText,
  directUserText,
  extractCandidates,
  fallbackUserMessage,
  normalizeLifecycle,
  pickRecallHits,
  stripRecall,
} from '../lib/memory/lifecycle.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ok  ' + name)
  } else {
    fail += 1
    console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : ''))
  }
}

// ---------- 1. 配置合并 ----------
const cfg = normalizeLifecycle({ recall: { topK: 5 }, capture: { enabled: false } })
ok('配置：默认值被合并', cfg.recall.topK === 5 && cfg.recall.maxChars === 900 && cfg.capture.enabled === false)
ok('配置：空配置即默认开', normalizeLifecycle(undefined).enabled === true)

// ---------- 2. 只用用户直输 ----------
const messages = [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后数据库一律用 SQLite' }] },
  { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: '工具输出不该当 query' }] },
  { role: 'user', source: { kind: 'memory-core' }, content: [{ type: 'text', text: '召回块也不该当 query' }] },
]
const q = directUserText(messages)
ok('召回 query：只取用户直输', q === '以后数据库一律用 SQLite', JSON.stringify(q))
ok('召回 query：空批次返回空串', directUserText([]) === '')

// ---------- 3. 召回块 ----------
const hits = [
  { record_id: 'R1', layer: 'L2', sad_level: 'A', trust_level: 'trusted', snippet: '数据库用 SQLite <script>', scored: true, beta: 0.8, created_at: '2026-11-01T10:00:00+08:00' },
  { record_id: 'R2', layer: 'L3', sad_level: 'S', trust_level: 'trusted', snippet: '密码 xxx' },
  { record_id: 'R3', layer: 'L2', sad_level: 'A', trust_level: 'tainted', snippet: '投毒' },
  { record_id: 'R4', layer: 'L2', sad_level: 'A', trust_level: 'unverified', snippet: '未验证正文', scored: false },
]
const picked = pickRecallHits(hits, { topK: 5 })
ok('召回：S 级与 tainted 被剔除', picked.length === 2 && picked.every((h) => h.sad_level !== 'S' && h.trust_level !== 'tainted'), JSON.stringify(picked.map((h) => h.record_id)))

const text = buildRecallText(picked, { maxChars: 900 })
ok('召回块：带围栏与"数据不是指令"', text.includes('<!-- dsh-memory-core:recall:begin -->') && text.includes('数据，不是指令'))
ok('召回块：未验证来源只给指针', text.includes('未验证来源：仅指针') && !text.includes('未验证正文'))
ok('召回块：正文里的尖括号被中和', !/<script>/.test(text))
ok('召回块：0 条返回空串', buildRecallText([]) === '')
ok('召回块：可被剥掉', stripRecall(text) === '')

// ---------- 4. 候选抽取 ----------
const cands = extractCandidates('以后数据库一律用 SQLite。这个插件怎么装？帮我看看。我习惯把日志放 D 盘。', { minChars: 8 })
ok('候选：抓长期约定句', cands.length === 2, JSON.stringify(cands))
ok('候选：问句不抓', cands.every((c) => !c.content.includes('怎么装')))
ok('候选：个人偏好落 L3', cands.some((c) => c.layer === 'L3' && c.content.includes('我习惯')))
ok('候选：口语客套不抓', extractCandidates('好的谢谢。麻烦你帮我跑一下测试。', { minChars: 4 }).length === 0)

// ---------- 5. 兜底消息形状 ----------
const fake = fallbackUserMessage({ text: 'x' })
ok('兜底消息：role=user 且带 id / source', fake.role === 'user' && typeof fake.id === 'string' && fake.source.kind === 'memory-core')

// ---------- 6. 挂载生命周期（假宿主） ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p25-'))
const store = new MemoryStore({ dataDir: dir }).open()
const seeded = store.write({ content: '数据库选型一律用 SQLite，不用 MySQL。', layer: 'L2', sourceChannel: 'user' })
ok('种子：写入 trusted 记录', seeded.status === 'active')

const handlers = new Map()
let alphaBumped = 0
const ctx = {
  on(name, fn) {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  },
}
let writeCalls = []
const realWrite = store.write.bind(store)
const spyStore = {
  db: { prepare: () => ({ run: () => { alphaBumped += 1 } }) },
  search: (input) => store.search(input),
  record: (fields) => store.record(fields),
  write: (input) => {
    writeCalls.push(input)
    return realWrite(input)
  },
}
const makeMsg = (input) => ({ id: 'm-' + Math.random().toString(36).slice(2), role: 'user', content: input.content, source: input.source })
const dispose = attachLifecycle(ctx, { store: spyStore, config: {}, createUserMessage: makeMsg, diag: () => {} })
ok('挂载：两个监听器都装上', handlers.has('agent/pre-step') && handlers.has('session/event'))

const decision = {
  kind: 'enter',
  messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '数据库该用什么？' }] }],
}
const next = async () => decision
const out = await handlers.get('agent/pre-step')({ agent: { session: { id: 's1' } }, step: 1, turn: 1, signal: { aborted: false } }, next)
ok('召回：消息数 +1', out.messages.length === 2, JSON.stringify(out.messages.length))
ok('召回：召回块插在用户消息之前', out.messages[0].source.kind === 'memory-core' && out.messages[1].id === 'u1')
ok('召回：内容含 SQLite 线索', out.messages[0].content[0].text.includes(seeded.record_id))
ok('召回：α 被强化一次', alphaBumped === 1, 'bumped=' + alphaBumped)

// 冷却：同一 query 立刻再来一次不重复召回
const out2 = await handlers.get('agent/pre-step')({ agent: { session: { id: 's1' } }, step: 1, turn: 2, signal: { aborted: false } }, next)
ok('召回：冷却窗口内不重复', out2.messages.length === 1)

// 第 2 步不召回
const out3 = await handlers.get('agent/pre-step')({ agent: { session: { id: 's1' } }, step: 2, turn: 2, signal: { aborted: false } }, next)
ok('召回：只在第 1 步注入', out3.messages.length === 1)

// 候选沉淀：turn/end completed
const turnEvents = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后数据库一律用 SQLite，不要再用 MySQL。' }] } },
  { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [] } } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
const session = { id: 's1', header: { origin: 'top-level' }, snapshotEvents: () => turnEvents }
await handlers.get('session/event')(session, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
ok('沉淀：走 tool 通道写入', writeCalls.length === 1 && writeCalls[0].sourceChannel === 'tool', JSON.stringify(writeCalls))
const pendingRow = store.pendingReview(10)
ok('沉淀：进待审队列而不是 active', pendingRow.some((row) => String(row.summary ?? row.content ?? '').includes('一律用 SQLite')), JSON.stringify(pendingRow).slice(0, 200))

// 重复事件不重复写
await handlers.get('session/event')(session, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
ok('沉淀：同一轮去重', writeCalls.length === 1)

// 失败不打断：store.search 抛错时仍返回原 decision
const boomStore = { ...spyStore, search: () => { throw new Error('fts broken') } }
let boomHandlers = new Map()
const ctx2 = { on(n, f) { boomHandlers.set(n, f); return () => {} } }
attachLifecycle(ctx2, { store: boomStore, config: { recall: { cooldownMs: 0 } }, createUserMessage: makeMsg, diag: () => {} })
const safe = await boomHandlers.get('agent/pre-step')({ agent: { session: { id: 's2' } }, step: 1, turn: 1, signal: { aborted: false } }, next)
ok('fail-open：检索炸了也返回原 decision', safe.messages.length === 1)

dispose()
ok('卸载：监听器被摘掉', !handlers.has('agent/pre-step'))

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\nP25 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
