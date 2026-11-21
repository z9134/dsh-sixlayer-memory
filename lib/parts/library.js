/**
 * library.js — 零件库（集市索引的本地快照）。
 *
 * 数据来源：catalog/parts.json（由 tools/refresh-catalog.mjs 从集市索引生成）
 * 只做只读搜索，不执行安装；安装命令原样返回，由用户复制执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CATALOG_FILE = path.resolve(HERE, '..', '..', 'catalog', 'parts.json')

let cache = null

export function loadCatalog() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    cache = { source: '', fetchedAt: null, total: 0, count: 0, parts: [] }
  }
  return cache
}

export function catalogMeta() {
  const c = loadCatalog()
  return {
    source: c.source,
    fetchedAt: c.fetchedAt ?? null,
    total: c.total ?? 0,
    count: c.count ?? 0,
    categories: categoryCounts(c.parts ?? []),
  }
}

function categoryCounts(parts) {
  const map = {}
  for (const p of parts) {
    const key = p.category || '其他'
    map[key] = (map[key] ?? 0) + 1
  }
  return map
}

function score(part, q) {
  if (!q) return (part.audited ? 1000 : 0) + Math.log10((part.stars ?? 0) + 10) * 10
  const name = String(part.name ?? '').toLowerCase()
  const author = String(part.author ?? '').toLowerCase()
  const summary = String(part.summary ?? '').toLowerCase()
  let s = 0
  if (name === q) s += 500
  else if (name.includes(q)) s += 200
  if (author.includes(q)) s += 80
  if (summary.includes(q)) s += 60
  if (part.audited) s += 40
  s += Math.log10((part.stars ?? 0) + 10) * 5
  return s
}

/**
 * 搜索零件库。
 * @param {{query?: string, category?: string, limit?: number}} input
 */
export function searchLibrary(input = {}) {
  const catalog = loadCatalog()
  const q = String(input.query ?? '').trim().toLowerCase()
  const category = String(input.category ?? '').trim()
  const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 200)

  let parts = catalog.parts ?? []
  if (category) parts = parts.filter((p) => (p.category || '其他') === category)
  if (q) parts = parts.filter((p) => {
    const hay = `${p.name ?? ''} ${p.author ?? ''} ${p.summary ?? ''}`.toLowerCase()
    return hay.includes(q)
  })

  const items = parts
    .map((p) => ({ ...p, _score: score(p, q) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...p }) => p)

  return {
    query: q,
    category,
    matched: items.length,
    total: catalog.count ?? 0,
    items,
  }
}
