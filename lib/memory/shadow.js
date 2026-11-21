/**
 * shadow.js — 影子读：新旧两路并排，看新库有没有漏。
 *
 * 旧路 = `~\.mnemon` 的 memories.json（按 bigram 做轻量 BM25，不建索引、不改源）；
 * 新路 = 本地六层库的 search。
 * 两路用"脱敏后内容的哈希"对齐到同一条记录，才能判"只有旧有 / 只有新有 / 都有"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tokenize } from './tokenize.js'
import { redact, brief } from './redact.js'
import { sha256, normalizeContent } from './util.js'

export class LegacyIndex {
  /** @param {{home?: string}} [options] */
  constructor(options = {}) {
    this.home = options.home ?? path.join(os.homedir(), '.mnemon')
    this.entries = []
    this.df = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    const file = path.join(this.home, 'runtime', 'memories.json')
    let raw = []
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        raw = Array.isArray(parsed) ? parsed : parsed.entries ?? []
      } catch {
        raw = []
      }
    }
    if (raw.length === 0) {
      const md = path.join(this.home, 'runtime', 'MEMORY.md')
      if (fs.existsSync(md)) {
        raw = fs.readFileSync(md, 'utf8').split(/\n\s*§\s*\n/g).map((content) => ({ content }))
      }
    }

    this.entries = raw
      .filter((e) => e && typeof e.content === 'string' && e.content.trim())
      .map((e, i) => {
        const normalized = normalizeContent(e.content)
        const sanitized = redact(normalized).text
        const tokens = tokenize(`${brief(sanitized, 120)} ${sanitized}`)
        return {
          legacy_id: `L${String(i + 1).padStart(2, '0')}`,
          target: e.target ?? 'memory',
          sanitized,
          content_hash: sha256(sanitized),
          tokens: new Set(tokens),
          length: tokens.length,
          preview: brief(sanitized, 90),
        }
      })

    for (const entry of this.entries) {
      for (const token of entry.tokens) this.df.set(token, (this.df.get(token) ?? 0) + 1)
    }
    this.loaded = true
    return this
  }

  /** 轻量 BM25：idf × 命中率，够用来做一致性比对，不追求召回质量。 */
  search(query, topK = 5) {
    this.load()
    const q = tokenize(String(query ?? ''))
    if (q.length === 0) return []
    const N = this.entries.length || 1
    const rows = []
    for (const entry of this.entries) {
      let score = 0
      let hit = 0
      for (const token of q) {
        if (!entry.tokens.has(token)) continue
        hit += 1
        const df = this.df.get(token) ?? 1
        score += Math.log(1 + N / df)
      }
      if (hit === 0) continue
      rows.push({
        legacy_id: entry.legacy_id,
        target: entry.target,
        snippet: entry.preview,
        score: score / Math.sqrt(Math.max(entry.length, 1)),
        content_hash: entry.content_hash,
      })
    }
    rows.sort((a, b) => b.score - a.score)
    return rows.slice(0, topK)
  }

  size() {
    this.load()
    return this.entries.length
  }
}

/**
 * 影子读比对。
 * @param {{store: any, index: LegacyIndex, query: string, topK?: number}} args
 */
export function shadowCompare({ store, index, query, topK = 5 }) {
  const legacyHits = index.search(query, topK)
  const newHits = store.search({ query, topK })

  // 用 content_hash 把旧条目对齐到新记录
  const byHash = new Map()
  for (const hit of legacyHits) {
    const row = store.db.prepare('SELECT record_id FROM records WHERE content_hash = ? LIMIT 1').get(hit.content_hash)
    byHash.set(hit.legacy_id, row ? row.record_id : null)
  }

  const legacyIds = new Set(byHash.values())
  const newIds = new Set(newHits.map((h) => h.record_id))
  const both = newHits.filter((h) => legacyIds.has(h.record_id)).map((h) => h.record_id)
  const onlyNew = newHits.filter((h) => !legacyIds.has(h.record_id)).map((h) => h.record_id)
  const onlyLegacy = legacyHits.filter((h) => !byHash.get(h.legacy_id)).map((h) => h.legacy_id)

  return {
    query,
    legacy: legacyHits.map((h) => ({ ...h, record_id: byHash.get(h.legacy_id) ?? '' })),
    mine: newHits.map((h) => ({ record_id: h.record_id, snippet: h.snippet, score: h.score })),
    diff: { both, only_legacy: onlyLegacy, only_new: onlyNew },
    consistent: onlyLegacy.length === 0,
    legacy_count: index.size(),
  }
}

export default LegacyIndex
