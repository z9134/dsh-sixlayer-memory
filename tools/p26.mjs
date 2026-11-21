/** p26：可选语义召回（向量）+ 同义词扩展 + fail-open */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import {
  EmbedIndex,
  cosine,
  createEmbedder,
  expandQuery,
  indexRecords,
  normalizeVector,
  resolveSemanticConfig,
  searchHybrid,
} from '../lib/memory/embed.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ' + name) } else { fail += 1; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

// ---------- 1. 向量数学 ----------
ok('cosine：同一向量 = 1', Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
ok('cosine：正交 = 0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9)
ok('cosine：反向 = -1', Math.abs(cosine([1, 1], [-1, -1]) + 1) < 1e-9)
ok('cosine：维度不符 = 0', cosine([1, 2], [1, 2, 3]) === 0)
const nv = normalizeVector([3, 4])
ok('normalize：模长为 1', Math.abs(Math.hypot(...nv) - 1) < 1e-9, JSON.stringify(nv))
ok('normalize：零向量不炸', normalizeVector([0, 0]).every((x) => x === 0))

// ---------- 2. 同义词扩展 ----------
const q1 = expandQuery('数据库怎么配的')
ok('扩展：命中数据库 → 带出 database/sql', /database/.test(q1) && /sql/.test(q1), q1)
ok('扩展：原查询完整保留在最前', q1.startsWith('数据库怎么配的'))
ok('扩展：无关词不扩', expandQuery('今天天气不错') === '今天天气不错')
const capped = expandQuery('数据库报错部署测试日志')
ok('扩展：总量有上限', capped.split(/\s+/).length <= 1 + 6 + 5, capped)

// ---------- 3. 语义配置 ----------
const off = resolveSemanticConfig(undefined)
ok('配置：默认关闭', off.enabled === false)
ok('配置：ollama 默认端点', off.endpoint.includes('11434'), off.endpoint)
const openai = resolveSemanticConfig({ enabled: true, provider: 'openai' })
ok('配置：openai 默认端点', openai.endpoint.includes('/v1/embeddings'), openai.endpoint)

// ---------- 4. 嵌入器 fail-open ----------
const flaky = createEmbedder(resolveSemanticConfig({ enabled: true, endpoint: 'http://127.0.0.1:1/x', timeoutMs: 200 }), {
  fetchImpl: async () => { throw new Error('conn refused') },
  log: () => {},
})
ok('嵌入器：连不上返回 null', (await flaky.embed('hello')) === null)
ok('嵌入器：失败后标记 broken', flaky.broken === true)
ok('嵌入器：未启用直接 null', (await createEmbedder(resolveSemanticConfig({ enabled: false })).embed('x')) === null)

// ---------- 5. 索引持久化 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p26-'))
const index = new EmbedIndex({ dataDir: dir })
index.put('r1', 'm1', [1, 0, 0], 'h1')
ok('索引：写入即命中', index.has('r1', 'm1') === true)
ok('索引：换模型视为未命中', index.has('r1', 'm2') === false)
index.save()
const reloaded = new EmbedIndex({ dataDir: dir })
ok('索引：落盘后可重载', reloaded.has('r1', 'm1') === true && reloaded.size === 1)
ok('索引：向量值原样保留', JSON.stringify(reloaded.get('r1', 'm1')) === '[1,0,0]')

// ---------- 6. 混合检索（真库 + 假嵌入器） ----------
const store = new MemoryStore({ dataDir: dir }).open()
const dbRec = store.write({ content: '数据库一律用 SQLite，不要再用 MySQL。', layer: 'L2', sourceChannel: 'user' })
const memRec = store.write({ content: '记忆注入要有围栏，防止提示词污染。', layer: 'L2', sourceChannel: 'user' })
const secret = store.write({ content: '生产库密码：Hunter2-prod；SSH root@10.0.0.9', layer: 'L3', sourceChannel: 'user' })
ok('准备：S 级记录被判 S', secret.sad_level === 'S')

// 假嵌入器：只按"主题"给正交向量
const TABLE = {
  '那个东西的存储方式': [1, 0, 0],
  '数据库一律用 SQLite，不要再用 MySQL。': [1, 0, 0],
  '记忆注入要有围栏，防止提示词污染。': [0, 1, 0],
  '生产库密码：Hunter2-prod；SSH root@10.0.0.9': [0, 0, 1],
}
const fakeEmbedder = { embed: async (text) => TABLE[text] ?? [0, 0, 1] }

const sem = resolveSemanticConfig({ enabled: true, model: 'm1', weight: 0.6, minScore: 0.5 })
const idx = new EmbedIndex({ dataDir: dir })
const built = await indexRecords({ store, index: idx, embedder: fakeEmbedder, semantic: sem, limit: 50 })
ok('索引：只给 active 非 S 记录建向量', built.indexed === 2, JSON.stringify(built))
ok('索引：S 级没有被索引', idx.has(secret.record_id, 'm1') === false)
ok('索引：重复执行不重算', (await indexRecords({ store, index: idx, embedder: fakeEmbedder, semantic: sem })).indexed === 0)

// 词法完全命中不了（无字面重叠、也无同义词命中）→ 靠向量捞回来
const hybrid = await searchHybrid({ store, query: '那个东西的存储方式', topK: 3, semantic: sem, index: idx, embedder: fakeEmbedder })
ok('混合：词法无命中时靠向量命中', hybrid.items.length >= 1 && hybrid.mode === 'hybrid', JSON.stringify({ mode: hybrid.mode, n: hybrid.items.length }))
ok('混合：命中就是那条数据库记忆', hybrid.items[0]?.record_id === dbRec.record_id, JSON.stringify(hybrid.items[0]?.snippet))
ok('混合：标记来源 why=vector', hybrid.items[0]?.why === 'vector', hybrid.items[0]?.why)
ok('混合：S 级不会被向量捞回来', hybrid.items.every((i) => i.record_id !== secret.record_id))

// 语义关闭 → 纯词法
const lexical = await searchHybrid({ store, query: 'SQLite', topK: 3, semantic: resolveSemanticConfig({ enabled: false }), index: idx, embedder: fakeEmbedder })
ok('混合：语义关时 mode=lexical', lexical.mode === 'lexical' && lexical.items.length >= 1, JSON.stringify(lexical.mode))

// 词法兜底：同义词二次 pass
const expandedHit = await searchHybrid({ store, query: 'docker 怎么跑', topK: 3, semantic: resolveSemanticConfig({ enabled: false }) })
ok('混合：无关查询返回空也不报错', Array.isArray(expandedHit.items))

// 嵌入器炸了 → 退回词法，不抛
const brokenEmbedder = { embed: async () => null }
const safe = await searchHybrid({ store, query: 'SQLite 数据库', topK: 3, semantic: sem, index: idx, embedder: brokenEmbedder })
ok('fail-open：嵌入失败退回词法', safe.mode === 'lexical' && safe.items.length >= 1, JSON.stringify(safe.mode))

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\nP26 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
