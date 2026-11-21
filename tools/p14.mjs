/** p14：QQ 官方机器人桥（token、identify、回复、白名单） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { QqOfficialBridge, INTENT_GROUP_AND_C2C } from '../lib/memory/qq-official.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p14-'))
const store = new MemoryStore({ dataDir: dir }).open()
store.write({ content: 'QQ 官方机器人桥测试记录，内容足够长避免被跳过', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted' })

const calls = []
const fetchMock = async (url, opts) => {
  calls.push({ url, opts })
  if (String(url).includes('getAppAccessToken')) return { json: async () => ({ access_token: 'tok', expires_in: 7200 }) }
  if (String(url).endsWith('/gateway')) return { json: async () => ({ url: 'wss://gw.example' }) }
  return { json: async () => ({ id: 'ok' }) }
}

const bridge = new QqOfficialBridge({
  store,
  config: { enabled: true, appId: '1906207408', appSecret: 'secret', allowedOpenids: [] },
  fetchImpl: fetchMock,
})
ok('enabled', bridge.enabled === true)
const token = await bridge._ensureToken()
ok('拿到 token', token === 'tok', token)
const token2 = await bridge._ensureToken()
ok('token 缓存', token2 === 'tok' && calls.filter((c) => String(c.url).includes('getAppAccessToken')).length === 1)

const sent = []
bridge.ws = { send: (s) => sent.push(JSON.parse(s)) }
bridge._onPayload({ op: 10, d: { heartbeat_interval: 30000 } }, 'tok')
ok('identify op=2', sent[0]?.op === 2, JSON.stringify(sent[0]))
ok('intents 含群与单聊', sent[0]?.d?.intents === INTENT_GROUP_AND_C2C, String(sent[0]?.d?.intents))
ok('identify token 前缀', sent[0]?.d?.token === 'QQBot tok', sent[0]?.d?.token)
clearInterval(bridge.heartbeatTimer)

const before = calls.length
await bridge._handleMessage('GROUP_AT_MESSAGE_CREATE', {
  group_openid: 'g1',
  content: '/状态',
  id: 'm1',
  author: { user_openid: 'u1' },
})
const replyCall = calls.slice(before).find((c) => String(c.url).includes('/v2/groups/g1/messages'))
ok('回复走群接口', Boolean(replyCall), JSON.stringify(calls.slice(before).map((c) => c.url)))
ok('回复内容含记录', Boolean(replyCall) && JSON.parse(replyCall.opts.body).content.includes('记录'), replyCall?.opts?.body)

const b2 = new QqOfficialBridge({
  store,
  config: { enabled: true, appId: '1', appSecret: 's', allowedOpenids: ['u9'] },
  fetchImpl: fetchMock,
})
const before2 = calls.length
await b2._handleMessage('C2C_MESSAGE_CREATE', { content: '/状态', id: 'm2', author: { user_openid: 'u1' } })
ok('白名单外不回复', calls.length === before2 && b2.stats.ignored === 1, `calls=${calls.length - before2} ignored=${b2.stats.ignored}`)

store.close()
console.log(`\nP14 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
