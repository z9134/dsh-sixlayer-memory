/**
 * server.mjs — 控制台原型（只读 + 假数据）。
 *
 *   node ui/server.mjs            # http://127.0.0.1:7788
 *   node ui/server.mjs --port 7799
 *
 * 设计口径：只监听 127.0.0.1；写操作一律不在此实现（回仓库走工具层）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seed } from './seed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 7788
const HOST = '127.0.0.1'

const JSON_HEAD = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

function json(res, body) {
  res.writeHead(200, JSON_HEAD)
  res.end(JSON.stringify(body))
}

function api(url) {
  if (url.pathname === '/api/meta') {
    return {
      authority: seed.meta.authority,
      chain: seed.meta.chain,
      sizeKb: seed.meta.sizeKb,
      snapshots: seed.meta.snapshots,
    }
  }
  if (url.pathname === '/api/overview') {
    return {
      ...seed.overview,
      authority: seed.meta.authority,
      chain: seed.meta.chain,
      sizeKb: seed.meta.sizeKb,
      snapshots: seed.meta.snapshots,
    }
  }
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim()
    const results = q ? seed.results : []
    return { query: q, ms: 3, results }
  }
  if (url.pathname.startsWith('/api/record/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/record/'.length))
    return id ? seed.record : null
  }
  if (url.pathname === '/api/traces') return { traces: seed.traces }
  return null
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  if (url.pathname.startsWith('/api/')) {
    const body = api(url)
    if (body === null) {
      res.writeHead(404, JSON_HEAD)
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    return json(res, body)
  }

  const entry = STATIC[url.pathname]
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  const [file, type] = entry
  try {
    const buf = fs.readFileSync(path.join(here, file))
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(buf)
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('500')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`记忆底座控制台（原型） http://${HOST}:${PORT}`)
  console.log('只监听本机；数据为演示用的假数据（seed.mjs）。')
})
