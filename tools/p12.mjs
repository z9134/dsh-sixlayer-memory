/** p12：HTTP API（token 鉴权、只读默认、S 级拦截） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { createApiHandler, ensureApiToken } from '../lib/memory/api.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p12-'))
const store = new MemoryStore({ dataDir: dir }).open()
store.write({ content: '记忆底座接入了 HTTP API，方便外部程序调用', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })
const secret = store.write({ content: '密钥是 sk-test-abc123，不要外传', layer: 'L2', sadLevel: 'S', sourceChannel: 'user', trustLevel: 'trusted' })

const token = ensureApiToken({ dataDir: dir })
ok('token 已生成', /^[0-9a-f]{32}$/.test(token), token.slice(0, 6))
const handler = createApiHandler({ store, token })
const auth = { authorization: 'Bearer ' + token }

const r401 = await handler({ path: 'status', method: 'GET', headers: {}, body: {} })
ok('无 token 401', r401.status === 401, String(r401.status))
const rBad = await handler({ path: 'status', method: 'GET', headers: { authorization: 'Bearer wrong' }, body: {} })
ok('错 token 401', rBad.status === 401)

const rStatus = await handler({ path: 'status', method: 'GET', headers: auth, body: {} })
ok('status 200', rStatus.status === 200 && rStatus.json.ok === true)
ok('status 不暴露 dataDir', rStatus.json.value?.dataDir === undefined)

const rRecall = await handler({ path: 'recall', method: 'POST', headers: auth, body: { query: 'HTTP API', topK: 5 } })
ok('recall 200', rRecall.status === 200 && Array.isArray(rRecall.json.value?.items))
ok('recall 不含 S', !rRecall.json.value.items.some((i) => i.record_id === secret.record_id))

const rReadSecret = await handler({ path: 'read', method: 'POST', headers: auth, body: { record_id: secret.record_id } })
ok('读 S 级 403', rReadSecret.status === 403, String(rReadSecret.status))

const rWrite = await handler({ path: 'remember', method: 'POST', headers: auth, body: { content: '外部写入测试内容足够长' } })
ok('只读模式拒绝写入', rWrite.status === 403, String(rWrite.status))

const writeHandler = createApiHandler({ store, token, allowWrite: true })
const rWrite2 = await writeHandler({ path: 'remember', method: 'POST', headers: auth, body: { content: '外部写入测试内容足够长' } })
ok('写入模式允许写入', rWrite2.status === 200 && Boolean(rWrite2.json.value?.record_id), JSON.stringify(rWrite2.json))
const row = store.db.prepare('SELECT status, source_channel FROM records WHERE record_id = ?').get(rWrite2.json.value.record_id)
ok('外部写入走待审', row?.status === 'pending', JSON.stringify(row))

const r404 = await handler({ path: 'nope', method: 'GET', headers: auth, body: {} })
ok('未知路由 404', r404.status === 404, String(r404.status))

store.close()
console.log(`\nP12 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
