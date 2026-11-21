/**
 * embed.js — 可选语义召回（向量）＋ 零依赖同义词扩展。
 *
 * 为什么要有这一层：FTS5 bigram 只能命中"字面相同"的查询。
 * 「上次那个内存占用的问题」找不到「RSS 峰值排查」——这是与市场竞品最大的功能差。
 *
 * 三条设计约束（不能破）：
 *  1. **默认关**：没配 embedding 服务的人，一分延迟都不加，行为与 2.0 完全一致。
 *  2. **永远兜底**：embed 超时/报错/没索引 → 退回纯词法，召回照常。
 *  3. **永不外发正文**：S 级与 tainted 不进索引；provider 指向本机时全程不出网。
 *
 * 索引存在 sidecar 文件（db/embeddings.json），不动 SQLite schema —— 不上迁移、不锁库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sha256, ensureDir } from './util.js'

export const DEFAULT_SEMANTIC = {
  enabled: false,
  provider: 'ollama', // ollama | openai
  endpoint: '',
  model: 'bge-m3',
  timeoutMs: 1500,
  weight: 0.55, // 混合分里向量占的权重
  minScore: 0.2,
  maxIndexPerRun: 200,
}

export function resolveSemanticConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_SEMANTIC, ...cfg }
  if (!merged.endpoint) {
    merged.endpoint =
      merged.provider === 'openai'
        ? 'http://127.0.0.1:1234/v1/embeddings'
        : 'http://127.0.0.1:11434/api/embeddings'
  }
  return merged
}

// ---------- 向量数学 ----------

export function normalizeVector(vec) {
  let norm = 0
  for (const x of vec) norm += x * x
  norm = Math.sqrt(norm)
  if (!norm) return vec.map(() => 0)
  return vec.map((x) => x / norm)
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

// ---------- 同义词扩展（零依赖，永远可用） ----------

/** 词表：一条 = 一组可互换说法。刻意只收高频开发词，宁缺毋滥。 */
const ALIASES = [
  ['数据库', 'database', 'db', 'sql'],
  ['报错', '错误', '异常', 'exception', 'error'],
  ['部署', '发布', '上线', 'deploy'],
  ['记忆', 'memory', '回忆'],
  ['配置', '设置', 'config', 'setting'],
  ['测试', 'test', 'spec', '单测'],
  ['日志', 'log', 'logs'],
  ['性能', '卡顿', '变慢', '慢', 'perf', 'latency'],
  ['接口', 'api', 'endpoint'],
  ['删除', '删掉', '清理', 'remove', 'delete'],
  ['修改', '改成', 'update', 'edit'],
  ['插件', 'plugin', '扩展'],
  ['仓库', 'repo', 'repository', 'git'],
  ['构建', '打包', 'build', 'compile'],
  ['依赖', 'deps', 'dependency', '包'],
  ['文档', 'doc', 'docs', 'readme'],
  ['视频', 'video', '录像'],
  ['语音', 'voice', 'tts', '音频'],
  ['模型', 'model', 'llm'],
  ['密钥', 'token', 'key', '凭证'],
]

/**
 * 把查询扩成"原查询 + 命中词的别名"。
 * @returns {string} 扩展后的查询（原始查询始终在前）
 */
export function expandQuery(query, { maxExtra = 6 } = {}) {
  const text = String(query ?? '').toLowerCase()
  if (!text) return ''
  const extra = []
  for (const group of ALIASES) {
    const hit = group.find((word) => text.includes(word.toLowerCase()))
    if (!hit) continue
    for (const word of group) {
      if (word.toLowerCase() === hit.toLowerCase()) continue
      if (text.includes(word.toLowerCase())) continue
      if (extra.includes(word)) continue
      extra.push(word)
      if (extra.length >= maxExtra) break
    }
    if (extra.length >= maxExtra) break
  }
  return extra.length ? `${query} ${extra.join(' ')}` : String(query ?? '')
}

// ---------- 嵌入索引（sidecar 文件） ----------

export class EmbedIndex {
  constructor({ dataDir, log = () => {} }) {
    this.file = path.join(dataDir, 'db', 'embeddings.json')
    this.log = log
    this.map = new Map() // record_id -> { m: model, h: hash, v: number[] }
    this.dirty = false
    this.timer = null
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [id, item] of Object.entries(raw?.items ?? {})) {
        if (item && Array.isArray(item.v) && item.v.length > 0) this.map.set(id, item)
      }
    } catch {
      /* 没有文件就是空索引 */
    }
    return this
  }

  get(id, model) {
    const item = this.map.get(String(id))
    if (!item) return null
    if (model && item.m !== model) return null
    return item.v
  }

  has(id, model) {
    return this.get(id, model) !== null
  }

  put(id, model, vec, textHash) {
    if (!Array.isArray(vec) || vec.length === 0) return
    this.map.set(String(id), { m: model, h: textHash ?? '', v: vec })
    this.dirty = true
    this.schedule()
  }

  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.save()
    }, 800)
    this.timer.unref?.()
  }

  save() {
    if (!this.dirty) return { saved: false }
    try {
      ensureDir(path.dirname(this.file))
      const items = Object.fromEntries(this.map)
      const tmp = `${this.file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }), 'utf8')
      fs.renameSync(tmp, this.file)
      this.dirty = false
      return { saved: true, size: this.map.size }
    } catch (error) {
      this.log('embed: save failed ' + (error?.message ?? String(error)))
      return { saved: false }
    }
  }

  stats() {
    return { size: this.map.size, file: this.file }
  }

  get size() {
    return this.map.size
  }
}

// ---------- 嵌入器（HTTP，fail-open） ----------

/**
 * @param {ReturnType<typeof resolveSemanticConfig>} cfg
 * @param {{fetchImpl?: Function, log?: Function}} [deps]
 */
export function createEmbedder(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const log = deps.log ?? (() => {})
  let broken = false

  async function embed(text) {
    if (cfg.enabled !== true) return null
    if (broken) return null
    if (typeof fetchImpl !== 'function') return null
    const input = String(text ?? '').trim()
    if (!input) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(100, Number(cfg.timeoutMs) || 1500))
    timer.unref?.()
    try {
      const body =
        cfg.provider === 'openai'
          ? { model: cfg.model, input: input.slice(0, 8000) }
          : { model: cfg.model, prompt: input.slice(0, 8000) }
      const res = await fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? 'no-response'}`)
      const json = await res.json()
      const vec =
        cfg.provider === 'openai'
          ? json?.data?.[0]?.embedding
          : (json?.embedding ?? json?.embeddings?.[0])
      if (!Array.isArray(vec) || vec.length === 0) throw new Error('empty embedding')
      return normalizeVector(vec.map(Number))
    } catch (error) {
      // 一次失败不代表永远坏，但避免每轮都等超时：本轮之后标记为坏，由调用方决定何时重试。
      broken = true
      log('embed: failed ' + (error?.message ?? String(error)))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    embed,
    reset() {
      broken = false
    },
    get broken() {
      return broken
    },
  }
}

// ---------- 混合检索 ----------

function lexicalToScore(rank, total) {
  if (total <= 1) return 1
  return 1 - rank / total
}

/**
 * 词法 → 同义词二次pass → 向量合并，全程 fail-open。
 *
 * @param {{store:any, query:string, topK?:number, semantic?:object, index?:EmbedIndex, embedder?:any}} input
 * @returns {Promise<{items:Array, mode:'lexical'|'expanded'|'hybrid', embedded:number}>}
 */
export async function searchHybrid({ store, query, topK = 3, semantic, index, embedder } = {}) {
  const q = String(query ?? '').trim()
  const limit = Math.max(1, Math.min(Number(topK) || 3, 10))
  if (!q) return { items: [], mode: 'lexical', embedded: 0 }

  let items = safeSearch(store, q, limit)
  let mode = 'lexical'
  let expanded = false

  if (items.length === 0) {
    const wider = expandQuery(q)
    if (wider && wider !== q) {
      const again = safeSearch(store, wider, limit)
      if (again.length > 0) {
        items = again
        mode = 'expanded'
        expanded = true
      }
    }
  }

  const cfg = semantic ? resolveSemanticConfig(semantic) : null
  if (!cfg || cfg.enabled !== true || !index || !embedder) {
    return { items: items.slice(0, limit), mode, embedded: 0 }
  }

  const queryVec = await embedder.embed(q)
  if (!queryVec) return { items: items.slice(0, limit), mode, embedded: 0 }

  // 候选池：词法命中 + 全库有向量的记录（已过滤 S/tainted）
  const pool = new Map()
  items.forEach((item, i) => {
    pool.set(item.record_id, { item, lex: lexicalToScore(i, items.length) })
  })
  const rows = index.map
  let embedded = 0
  for (const [recordId, entry] of rows) {
    if (cfg.model && entry.m !== cfg.model) continue
    const sim = cosine(queryVec, entry.v)
    if (sim < Number(cfg.minScore ?? 0.2)) continue
    embedded += 1
    const existing = pool.get(recordId)
    if (existing) existing.vec = sim
    else pool.set(recordId, { record_id: recordId, vec: sim, lex: 0 })
  }

  if (embedded === 0) return { items: items.slice(0, limit), mode, embedded: 0 }

  // 缺元数据的向量命中，回库补摘要
  const enriched = []
  for (const [, entry] of pool) {
    const item = entry.item ?? loadItem(store, entry.record_id)
    if (!item) continue
    const vec = Number(entry.vec ?? 0)
    const lex = Number(entry.lex ?? 0)
    const score = Number(cfg.weight) * vec + (1 - Number(cfg.weight)) * lex
    enriched.push({
      ...item,
      score,
      semantic: vec,
      lexical: lex,
      why: vec > 0 && lex > 0 ? 'both' : vec > 0 ? 'vector' : 'lexical',
    })
  }
  enriched.sort((a, b) => b.score - a.score)
  return { items: enriched.slice(0, limit), mode: 'hybrid', embedded, expanded }
}

function safeSearch(store, query, limit) {
  try {
    const rows = store.search({ query, topK: Math.max(limit * 4, limit) })
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function loadItem(store, recordId) {
  try {
    const row = store.db
      .prepare(
        `SELECT record_id, layer, summary, sad_level, trust_level, source_channel, project_id,
                created_at, content_hash, alpha, beta, scored
           FROM records WHERE record_id = ? AND status = 'active'
             AND sad_level != 'S' AND trust_level != 'tainted'`,
      )
      .get(String(recordId))
    if (!row) return null
    return { ...row, snippet: row.summary }
  } catch {
    return null
  }
}

/**
 * 给"还没算过向量"的记录补索引。只取 active、非 S、非 tainted。
 * @returns {Promise<{indexed:number, skipped:number}>}
 */
export async function indexRecords({ store, index, embedder, semantic, limit = 200 } = {}) {
  const cfg = resolveSemanticConfig(semantic)
  if (cfg.enabled !== true || !index || !embedder) return { indexed: 0, skipped: 0 }
  let rows = []
  try {
    rows = store.db
      .prepare(
        `SELECT record_id, content, content_hash FROM records
          WHERE status = 'active' AND sad_level != 'S' AND trust_level != 'tainted'
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(Number(limit) || 200, 2000)))
  } catch {
    return { indexed: 0, skipped: 0 }
  }
  let indexed = 0
  let skipped = 0
  for (const row of rows) {
    if (index.has(row.record_id, cfg.model)) {
      skipped += 1
      continue
    }
    const vec = await embedder.embed(row.content)
    if (!vec) {
      skipped += 1
      continue // 嵌入器坏了就别继续排队等超时
    }
    index.put(row.record_id, cfg.model, vec, row.content_hash ?? sha256(String(row.content ?? '')))
    indexed += 1
  }
  if (indexed > 0) index.save()
  return { indexed, skipped }
}
