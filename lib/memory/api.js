/**
 * api.js — 把记忆暴露成 HTTP API（只读优先）。
 *
 * 用途：让「不在 DSH 进程里」的程序（QQ 机器人、脚本、云函数）能调记忆。
 * 边界：
 *   - 默认只读：status / recall / read
 *   - 写入必须显式开 allowWrite，且仍然只读 S 级：S 级永不外发
 *   - token 走 Authorization: Bearer 或 x-api-token
 *   - 每个 token 每分钟 120 次
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_FILE = 'meta/api-token.txt'
const RATE_LIMIT = 120
const RATE_WINDOW_MS = 60_000

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 读或生成 API token（落盘，权限尽量收紧）。 */
export function ensureApiToken({ dataDir, configured }) {
  if (configured) return String(configured)
  const file = path.join(dataDir, TOKEN_FILE)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* 不存在就生成 */
  }
  const token = randomBytes(16).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 })
  return token
}

/**
 * 固定端口的 API 服务器（不依赖 DSH webServer 的随机端口）。
 * 返回未 listen 的 Server；调用方负责 `.listen(port, '127.0.0.1')`。
 * 只监听回环地址，外部要用请自己做隧道，避免意外暴露。
 */
export function createApiServer({ handler }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname
        .replace(/^\/+/, '')
        .replace(/^memory-core\/api\//, '')
        .replace(/^api\//, '')
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed = {}
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {
        parsed = {}
      }
      const result = await handler({ path: route, method: req.method ?? 'POST', headers: req.headers ?? {}, body: parsed })
      res.statusCode = result.status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(result.json))
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  })
}

function extractToken(headers) {
  const auth = headers?.authorization ?? headers?.Authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const direct = headers?.['x-api-token'] ?? headers?.['X-Api-Token']
  return typeof direct === 'string' ? direct.trim() : ''
}

/**
 * @param {{store: any, token: string, allowWrite?: boolean}} options
 * @returns {(req: {path: string, method: string, headers: object, body: any}) => Promise<{status: number, json: any}>}
 */
export function createApiHandler({ store, token, allowWrite = false }) {
  let windowStart = Date.now()
  let used = 0

  return async function handle(req) {
    const now = Date.now()
    if (now - windowStart > RATE_WINDOW_MS) {
      windowStart = now
      used = 0
    }
    used += 1
    if (used > RATE_LIMIT) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } }
    }

    if (!safeEqual(extractToken(req.headers), token)) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } }
    }

    const route = String(req.path ?? '').replace(/^\/+/, '')
    const body = req.body && typeof req.body === 'object' ? req.body : {}

    try {
      if (route === 'status') {
        const s = store.stats()
        return {
          status: 200,
          json: {
            ok: true,
            value: {
              records: s.records,
              active: s.active,
              pending: s.pending,
              sLevel: s.sLevel,
              schemaVersion: s.schemaVersion,
              auditOk: Boolean(s.audit?.ok),
            },
          },
        }
      }

      if (route === 'recall') {
        const query = String(body.query ?? '').trim()
        if (!query) return { status: 400, json: { ok: false, error: 'query_required' } }
        const topK = Math.min(Math.max(Number(body.topK ?? 5), 1), 20)
        const hits = store.search({ query, topK })
        return {
          status: 200,
          json: {
            ok: true,
            value: {
              items: hits.map((h) => ({
                record_id: h.record_id,
                layer: h.layer,
                summary: h.summary,
                score: h.score,
              })),
            },
          },
        }
      }

      if (route === 'read') {
        const record = store.read(String(body.record_id ?? ''), { includeSensitive: false })
        if (!record) return { status: 404, json: { ok: false, error: 'not_found' } }
        if (record.denied || record.sad_level === 'S') {
          return { status: 403, json: { ok: false, error: 's_level_denied' } }
        }
        return {
          status: 200,
          json: {
            ok: true,
            value: {
              record_id: record.record_id,
              layer: record.layer,
              sad_level: record.sad_level,
              trust_level: record.trust_level,
              summary: record.summary,
              content: record.content,
              created_at: record.created_at,
            },
          },
        }
      }

      if (route === 'remember') {
        if (!allowWrite) return { status: 403, json: { ok: false, error: 'write_disabled' } }
        const content = String(body.content ?? '').trim()
        if (!content) return { status: 400, json: { ok: false, error: 'content_required' } }
        const result = store.write({
          content,
          layer: body.layer ?? 'L2',
          sourceChannel: body.sourceChannel ?? 'api',
          trustLevel: 'unverified',
          explicit: true,
        })
        return {
          status: 200,
          json: { ok: true, value: { record_id: result.record_id, status: result.status, dedup: Boolean(result.dedup) } },
        }
      }

      return { status: 404, json: { ok: false, error: 'unknown_route' } }
    } catch (error) {
      return { status: 500, json: { ok: false, error: String(error?.message ?? error) } }
    }
  }
}
