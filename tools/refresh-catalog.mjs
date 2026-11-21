#!/usr/bin/env node
/**
 * refresh-catalog.mjs — 从集市索引生成工作台的「零件库」快照。
 *
 * 数据源：https://www.mydsh.xyz/market/index.json（9300+ 条）
 * 输出：catalog/parts.json（精简字段，无 BOM）
 *
 * 用法：node tools/refresh-catalog.mjs [--min-stars 50] [--limit 800]
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const minStars = Number(args[args.indexOf('--min-stars') + 1]) || 50
const limit = Number(args[args.indexOf('--limit') + 1]) || 800
const INDEX_URL = 'https://www.mydsh.xyz/market/index.json'

const outDir = path.resolve('catalog')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'parts.json')

let raw
try {
  raw = JSON.parse(fs.readFileSync(path.join(outDir, '.index.json'), 'utf8'))
} catch {
  const res = await fetch(INDEX_URL, { headers: { 'user-agent': 'dsh-workbench-catalog' } })
  raw = await res.json()
  fs.writeFileSync(path.join(outDir, '.index.json'), JSON.stringify(raw), 'utf8')
}

const plugins = raw.plugins ?? []
const picked = plugins
  .filter((p) => Boolean(p.audited) || Number(p.stars ?? 0) >= minStars)
  .sort((a, b) => {
    const auditedDiff = Number(Boolean(b.audited)) - Number(Boolean(a.audited))
    if (auditedDiff !== 0) return auditedDiff
    return Number(b.stars ?? 0) - Number(a.stars ?? 0)
  })
  .slice(0, limit)
  .map((p) => ({
    id: p.id,
    name: p.name,
    author: p.author,
    category: p.category,
    stars: Number(p.stars ?? 0),
    summary: p.summary ?? '',
    repo: p.repo,
    install: p.install ?? '',
    audited: Boolean(p.audited),
  }))

const payload = {
  source: INDEX_URL,
  fetchedAt: new Date().toISOString(),
  total: plugins.length,
  count: picked.length,
  parts: picked,
}
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log(`catalog: ${picked.length}/${plugins.length} 条 → ${outFile}`)
