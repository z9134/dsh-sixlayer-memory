/**
 * qq-official.js — QQ 官方机器人（QQ Bot v2）桥。
 *
 * 流程：
 *   AppID + AppSecret → access_token（2 小时有效，提前刷新）
 *   → GET /gateway 拿 WS 地址
 *   → WS：op 10 Hello 后发 op 2 Identify（intents = GROUP_AND_C2C）
 *   → 收到 GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE
 *   → 复用 runMemoryCommand → POST /v2/groups|users/{openid}/messages 回复
 *
 * 安全：AppSecret 只读本地配置文件，不进日志；白名单按 openid 过滤。
 */
import { runMemoryCommand, parseCommand } from './qq.js'

const API_BASE = 'https://api.sgroup.qq.com'
const SANDBOX_BASE = 'https://sandbox.api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
export const INTENT_GROUP_AND_C2C = 1 << 25

export class QqOfficialBridge {
  constructor({ store, config, log, fetchImpl }) {
    if (!store) throw new Error('QqOfficialBridge: store 必填')
    this.store = store
    this.config = config ?? {}
    this.log = log ?? (() => {})
    this.fetch = fetchImpl ?? globalThis.fetch
    this.accessToken = ''
    this.expiresAt = 0
    this.ws = null
    this.stopped = true
    this.seq = null
    this.heartbeatTimer = null
    this.stats = { connected: false, received: 0, replied: 0, ignored: 0, errors: 0 }
  }

  get enabled() {
    return this.config.enabled === true && Boolean(this.config.appId) && Boolean(this.config.appSecret)
  }

  get baseUrl() {
    return this.config.sandbox ? SANDBOX_BASE : API_BASE
  }

  status() {
    return { ...this.stats, enabled: this.enabled, appId: this.config.appId ?? null, sandbox: Boolean(this.config.sandbox) }
  }

  async start() {
    if (!this.enabled || !this.stopped) return
    this.stopped = false
    await this._connect()
  }

  stop() {
    this.stopped = true
    clearInterval(this.heartbeatTimer)
    try {
      this.ws?.close()
    } catch {
      /* 忽略 */
    }
    this.ws = null
    this.stats.connected = false
  }

  async _ensureToken() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: String(this.config.appId), clientSecret: String(this.config.appSecret) }),
    })
    const json = await res.json()
    if (!json?.access_token) throw new Error('获取 access_token 失败：' + JSON.stringify(json).slice(0, 200))
    this.accessToken = json.access_token
    this.expiresAt = Date.now() + Number(json.expires_in ?? 7200) * 1000
    return this.accessToken
  }

  async _connect() {
    if (this.stopped) return
    try {
      const token = await this._ensureToken()
      const res = await this.fetch(`${this.baseUrl}/gateway`, { headers: { authorization: 'QQBot ' + token } })
      const json = await res.json()
      if (!json?.url) throw new Error('获取网关失败：' + JSON.stringify(json).slice(0, 200))
      this._openSocket(json.url, token)
    } catch (error) {
      this.stats.errors += 1
      this.log('qq-official: ' + (error?.message ?? String(error)))
      if (!this.stopped) setTimeout(() => this._connect(), 5000)
    }
  }

  _openSocket(url, token) {
    const ws = new WebSocket(url)
    this.ws = ws
    ws.addEventListener('open', () => {
      this.stats.connected = true
      this.log('qq-official: 已连接网关')
    })
    ws.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        return
      }
      this._onPayload(payload, token)
    })
    ws.addEventListener('close', () => {
      this.stats.connected = false
      clearInterval(this.heartbeatTimer)
      if (!this.stopped) setTimeout(() => this._connect(), 3000)
    })
    ws.addEventListener('error', () => {
      this.stats.errors += 1
    })
  }

  _send(payload) {
    try {
      this.ws?.send(JSON.stringify(payload))
    } catch {
      /* 忽略 */
    }
  }

  _onPayload(payload, token) {
    if (payload?.s !== undefined) this.seq = payload.s
    if (payload?.op === 10) {
      this._send({
        op: 2,
        d: { token: 'QQBot ' + token, intents: INTENT_GROUP_AND_C2C, shard: [0, 1] },
      })
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => this._send({ op: 1, d: this.seq }), payload.d?.heartbeat_interval ?? 30000)
      return
    }
    if (payload?.op === 0) {
      this._onDispatch(payload.t, payload.d)
    }
  }

  _onDispatch(type, data) {
    if (type !== 'GROUP_AT_MESSAGE_CREATE' && type !== 'C2C_MESSAGE_CREATE') return
    this.stats.received += 1
    this._handleMessage(type, data).catch((error) => {
      this.stats.errors += 1
      this.log('qq-official: 处理失败 ' + (error?.message ?? String(error)))
    })
  }

  async _handleMessage(type, data) {
    const content = String(data?.content ?? '').trim()
    const isGroup = type === 'GROUP_AT_MESSAGE_CREATE'
    const openid = isGroup ? String(data?.group_openid ?? '') : String(data?.author?.user_openid ?? data?.author?.id ?? '')
    if (!openid) {
      this.stats.ignored += 1
      return
    }
    const allowed = (this.config.allowedOpenids ?? []).map(String).filter(Boolean)
    if (allowed.length > 0 && !allowed.includes(openid)) {
      this.stats.ignored += 1
      return
    }
    const parsed = parseCommand(content, this.config.prefix ?? '/')
    if (!parsed) return
    const reply = await runMemoryCommand(this.store, parsed, {
      userId: openid,
      groupId: isGroup ? openid : '',
      isGroup,
    })
    if (!reply) return
    await this._reply(type, data, reply)
    this.stats.replied += 1
  }

  /** 回复消息（QQ Bot v2 群/单聊接口）。 */
  async _reply(type, data, content) {
    const token = await this._ensureToken()
    const isGroup = type === 'GROUP_AT_MESSAGE_CREATE'
    const url = isGroup
      ? `${this.baseUrl}/v2/groups/${data.group_openid}/messages`
      : `${this.baseUrl}/v2/users/${data.author?.user_openid ?? ''}/messages`
    return this.fetch(url, {
      method: 'POST',
      headers: { authorization: 'QQBot ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ content, msg_type: 0, msg_id: data.id }),
    })
  }
}

export function createQqOfficialBridge(options) {
  return new QqOfficialBridge(options)
}
