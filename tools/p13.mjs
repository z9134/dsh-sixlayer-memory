/** p13：固定端口 API 服务器（真实 HTTP 往返） */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { createApiHandler, ensureApiToken, createApiServer } from '../lib/memory/api.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

/** 用 node:http 而不是 fetch：undici 的 keep-alive 连接会在 process.exit 时
 *  和 libuv 的 async handle 抢关闭，Windows 上直接断言崩溃（exit 0xC0000409）。 */
function request(port, { method = 'GET', path: urlPath = '/status', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch { /* 非 JSON 就留空 */ }
          resolve({ status: res.statusCode, json, text })
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p13-'))
const store = new MemoryStore({ dataDir: dir }).open()
store.write({ content: '固定端口监听测试，记忆底座对外提供 HTTP 服务', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })
const token = ensureApiToken({ dataDir: dir })
const handler = createApiHandler({ store, token })
const server = createApiServer({ handler })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
ok('监听在随机端口', port > 0, String(port))

const bad = await request(port)
ok('无 token 401', bad.status === 401, String(bad.status))

const good = await request(port, { headers: { authorization: 'Bearer ' + token } })
ok('status 200', good.status === 200 && good.json?.ok === true, JSON.stringify(good.json).slice(0, 120))

const recall = await request(port, {
  method: 'POST',
  path: '/recall',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ query: '固定端口', topK: 3 }),
})
ok('recall 200', recall.status === 200 && Array.isArray(recall.json?.value?.items), JSON.stringify(recall.json).slice(0, 120))

server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
store.close()
console.log(`\nP13 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
