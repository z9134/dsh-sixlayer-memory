/**
 * qq.js — QQ 机器人桥（OneBot v11 WebSocket 客户端）。
 *
 * 为什么是「客户端」而不是「收 webhook」：
 *   DSH 的 webServer 端口每次重启会变，让 NapCat 反向 HTTP 指过来很脆弱；
 *   反过来由我们连 NapCat 的 WebSocket 服务端，端口固定、断线可重连。
 *
 * 职责边界：
 *   - 只做「IM → 记忆」的消费侧：记 / 搜 / 联想 / 状态 / 最近
 *   - 不碰 S 级正文；QQ 写入一律 unverified → 先审后入（闸门公理不变）
 *   - 白名单之外的消息直接忽略，不回复、不落库
 */

const DEFAULTS = {
  wsUrl: 'ws://127.0.0.1:3001',
  accessToken: '',
  allowedUsers: [],
  allowedGroups: [],
  rateLimitMs: 2000,
  prefix: '/',
}

function nowMs() {
  return Date.now()
}

/** 把 OneBot 消息段数组压成纯文本。 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return ''
  return segments
    .map((seg) => {
      if (!seg || typeof seg !== 'object') return ''
      if (seg.type === 'text') return String(seg.data?.text ?? '')
      if (seg.type === 'at') return `@${seg.data?.qq ?? ''}`
      if (seg.type === 'image') return '[图片]'
      if (seg.type === 'face') return '[表情]'
      return ''
    })
    .join('')
    .trim()
}

/** 解析命令：返回 { cmd, arg }；不是命令返回 null。 */
export function parseCommand(text, prefix = '/') {
  const body = String(text ?? '').trim()
  if (!body.startsWith(prefix)) return null
  const rest = body.slice(prefix.length).trim()
  if (!rest) return null
  const match = rest.match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return null
  const raw = match[1].toLowerCase()
  const arg = match[2].trim()
  const alias = {
    记: 'remember', 记住: 'remember', remember: 'remember', add: 'remember',
    搜: 'search', 搜索: 'search', search: 'search', find: 'search',
    联想: 'associate', associate: 'associate', relate: 'associate',
    状态: 'status', status: 'status', stat: 'status',
    最近: 'recent', recent: 'recent', latest: 'recent',
    帮助: 'help', help: 'help', '?': 'help',
  }
  const cmd = alias[raw]
  if (!cmd) return { cmd: 'unknown', arg: rest }
  return { cmd, arg }
}

function oneLine(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export class QqBridge {
  /**
   * @param {{store: any, config?: object, log?: (msg: string) => void}} options
   */
  constructor(options) {
    if (!options?.store) throw new Error('QqBridge: store 必填')
    this.store = options.store
    this.config = { ...DEFAULTS, ...(options.config ?? {}) }
    this.log = options.log ?? (() => {})
    this.ws = null
    this.stopped = true
    this.retry = 0
    this.timer = null
    this.pending = new Map()
    this.lastCmdAt = new Map()
    this.stats = { connected: false, received: 0, replied: 0, ignored: 0, errors: 0 }
  }

  get enabled() {
    return this.config.enabled !== false && Boolean(this.config.wsUrl)
  }

  start() {
    if (!this.enabled || !this.stopped) return
    this.stopped = false
    this._connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* 忽略 */
    }
    this.ws = null
    this.stats.connected = false
  }

  status() {
    return { ...this.stats, wsUrl: this.config.wsUrl, enabled: this.enabled }
  }

  _connect() {
    if (this.stopped) return
    let socket
    try {
      const url = new URL(this.config.wsUrl)
      socket = new WebSocket(url, {
        headers: this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {},
      })
    } catch (error) {
      this.stats.errors += 1
      this.log('qq: WebSocket 创建失败：' + (error?.message ?? String(error)))
      this._scheduleRetry()
      return
    }
    this.ws = socket
    socket.addEventListener('open', () => {
      this.retry = 0
      this.stats.connected = true
      this.log('qq: 已连接 ' + this.config.wsUrl)
    })
    socket.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      this._onPayload(payload)
    })
    socket.addEventListener('close', () => {
      this.stats.connected = false
      if (!this.stopped) this._scheduleRetry()
    })
    socket.addEventListener('error', () => {
      this.stats.errors += 1
    })
  }

  _scheduleRetry() {
    if (this.stopped) return
    this.retry = Math.min(this.retry + 1, 6)
    const delay = Math.min(30000, 1000 * 2 ** this.retry)
    this.timer = setTimeout(() => this._connect(), delay)
  }

  _onPayload(payload) {
    if (!payload || typeof payload !== 'object') return
    // API 响应
    if (typeof payload.echo === 'string' && payload.action === undefined) {
      const pending = this.pending.get(payload.echo)
      if (pending) {
        this.pending.delete(payload.echo)
        pending.resolve(payload)
      }
      return
    }
    if (payload.post_type !== 'message') return
    this.stats.received += 1
    this._handleEvent(payload).catch((error) => {
      this.stats.errors += 1
      this.log('qq: 处理消息失败：' + (error?.message ?? String(error)))
    })
  }

  async _handleEvent(event) {
    const selfId = String(event.self_id ?? '')
    const userId = String(event.user_id ?? '')
    const groupId = String(event.group_id ?? '')
    if (userId === selfId) return

    const text = segmentsToText(event.message)
    const isGroup = event.message_type === 'group'
    const isPrivate = event.message_type === 'private'
    if (!isGroup && !isPrivate) return

    // 白名单：没配就是全拒（安全默认）
    const allowed =
      isGroup
        ? this.config.allowedGroups.map(String).includes(groupId)
        : this.config.allowedUsers.map(String).includes(userId)
    if (!allowed) {
      this.stats.ignored += 1
      return
    }

    // 群聊要求 @ 机器人（私聊不要求）
    if (isGroup) {
      const mentioned = Array.isArray(event.message) && event.message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === selfId)
      if (!mentioned) {
        this.stats.ignored += 1
        return
      }
    }

    const parsed = parseCommand(text, this.config.prefix)
    if (!parsed) return

    // 简单限流：同一用户 2 秒一条
    const key = userId
    const last = this.lastCmdAt.get(key) ?? 0
    if (nowMs() - last < this.config.rateLimitMs) {
      this.stats.ignored += 1
      return
    }
    this.lastCmdAt.set(key, nowMs())

    const reply = await this.handleCommand(parsed, { userId, groupId, isGroup, messageId: event.message_id })
    if (!reply) return
    const target = isGroup ? { message_type: 'group', group_id: Number(groupId) } : { message_type: 'private', user_id: Number(userId) }
    await this._call('send_msg', { ...target, message: reply })
    this.stats.replied += 1
  }

  /** 命令处理：纯函数式，便于单测。 */
  async handleCommand(parsed, context = {}) {
    return runMemoryCommand(this.store, parsed, context)
  }

  _call(action, params) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) {
        resolve({ status: 'failed', retcode: -1, message: 'not connected' })
        return
      }
      const echo = `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      this.pending.set(echo, { resolve })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        this.pending.delete(echo)
        resolve({ status: 'failed', retcode: -1, message: error?.message ?? String(error) })
        return
      }
      setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo)
          resolve({ status: 'failed', retcode: -1, message: 'timeout' })
        }
      }, 10000)
    })
  }
}

/** 命令实现（两个桥共用：OneBot 本地 / QQ 官方）。 */
export async function runMemoryCommand(store, parsed, context = {}) {
  const arg = String(parsed?.arg ?? '').trim()
  switch (parsed?.cmd) {
    case 'remember': {
      if (!arg) return '用法：/记 <要记住的内容>'
      const result = store.write({
        content: arg,
        layer: 'L2',
        sourceChannel: 'qq',
        trustLevel: 'unverified',
        explicit: true,
        principalId: context.userId ? `qq:${context.userId}` : null,
      })
      return result?.dedup ? `已存在相同内容：${result.record_id}` : `已记下（待审）：${result.record_id}`
    }
    case 'search': {
      if (!arg) return '用法：/搜 <关键词>'
      const hits = store.search({ query: arg, topK: 3 })
      if (!hits.length) return '没搜到相关记忆。'
      return ['搜到：', ...hits.map((h, i) => `${i + 1}. [${h.layer}] ${oneLine(h.summary, 50)}`)].join('\n')
    }
    case 'associate': {
      if (!arg) return '用法：/联想 <关键词或一句话>'
      const result = store.associate({ query: arg, topK: 3 })
      if (!result.items.length) return '没想到相关的记忆。'
      return [
        '联想到：',
        ...result.items.map((it, i) => `${i + 1}. [${it.layer}] ${oneLine(it.summary, 50)}（${it.reasons.join('、')}）`),
      ].join('\n')
    }
    case 'recent': {
      const rows = store.db
        .prepare(
          "SELECT record_id, layer, summary FROM records WHERE status = 'active' AND sad_level != 'S' ORDER BY created_at DESC LIMIT 5",
        )
        .all()
      if (!rows.length) return '还没有记忆。'
      return ['最近：', ...rows.map((r, i) => `${i + 1}. [${r.layer}] ${oneLine(r.summary, 50)}`)].join('\n')
    }
    case 'status': {
      const s = store.stats()
      return [
        `记录 ${s.records}（S 级 ${s.sLevel}）`,
        `待审 ${s.pending}`,
        `审计 ${s.audit?.ok ? '一致' : '异常'}`,
        `schema v${s.schemaVersion}`,
      ].join('\n')
    }
    case 'help':
      return [
        '可用命令：',
        '/记 <内容> — 写入记忆（先审后入）',
        '/搜 <关键词> — 检索',
        '/联想 <关键词> — 由 A 想到 B',
        '/最近 — 最近 5 条',
        '/状态 — 库健康',
      ].join('\n')
    default:
      return '不认识的命令，发 /帮助 看用法。'
  }
}

export function createQqBridge(options) {
  return new QqBridge(options)
}
