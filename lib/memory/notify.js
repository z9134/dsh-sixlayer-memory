/**
 * notify.js — 通知链路（P3）：QQ 邮箱 SMTP → 飞书 webhook → 本地 outbox。
 *
 * 三条铁律（v3 方案 §7）：
 *  1. 报告永远先落盘，再发通知；发送失败不影响报告产出。
 *  2. 逐级兜底：SMTP 失败转飞书，飞书也失败转本地 outbox。
 *  3. 凭据只从受保护的配置文件读，绝不写进报告、日志或返回体。
 *
 * 零依赖：SMTP 用 node:tls 手写（只支持 AUTH LOGIN + STARTTLS/SSL），
 * 飞书用内置 fetch。够用即可，不引 nodemailer。
 */
import fs from 'node:fs'
import tls from 'node:tls'

export const CONFIG_PATH = 'D:/001/CH002/dsh-memory-data/meta/smtp.json'

export function loadNotifyConfig(file = CONFIG_PATH) {
  try {
    // Windows 上用记事本/PowerShell 存文件很容易带 BOM，JSON.parse 会直接失败。
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

function encodeHeader(text) {
  return `=?UTF-8?B?${b64(text)}?=`
}

function messageId() {
  return `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}@dsh-memory-core>`
}

/**
 * 发一封纯文本邮件。成功返回 {channel:'smtp'}，失败抛错。
 */
export function sendMail({ subject, text }, config = loadNotifyConfig()) {
  const cfg = config
  if (!cfg.host || !cfg.port || !cfg.user || !cfg.to || !cfg.authCode) {
    throw new Error('smtp 配置不完整：需要 host/port/user/to/authCode')
  }
  const body = b64(text).replace(/(.{76})/g, '$1\r\n')
  const data = [
    `From: ${encodeHeader('记忆底座')} <${cfg.user}>`,
    `To: <${cfg.to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n')

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: true })
    let buffer = ''
    let staged = 0
    let settled = false

    const steps = [
      { code: 220, send: () => 'EHLO dsh-memory\r\n' },
      { code: 250, send: () => 'AUTH LOGIN\r\n' },
      { code: 334, send: () => `${b64(cfg.user)}\r\n` },
      { code: 334, send: () => `${b64(cfg.authCode)}\r\n` },
      { code: 235, send: () => `MAIL FROM:<${cfg.user}>\r\n` },
      { code: 250, send: () => `RCPT TO:<${cfg.to}>\r\n` },
      { code: 250, send: () => 'DATA\r\n' },
      { code: 354, send: () => `${data}\r\n.\r\n` },
      { code: 250, send: () => 'QUIT\r\n' },
    ]

    const fail = (error) => {
      if (settled) return
      settled = true
      try {
        socket.end()
      } catch {
        /* 忽略 */
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    socket.setTimeout(20000, () => fail(new Error('SMTP 超时')))
    socket.on('error', fail)

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (!/^\d{3}[ -]/.test(line)) continue
        // 多行响应：以 "250-..." 开头时还要继续读
        if (/^\d{3}-/.test(line)) continue
        const code = Number(line.slice(0, 3))
        const step = steps[staged]
        if (!step) return
        if (code !== step.code) {
          fail(new Error(`SMTP 第 ${staged + 1} 步期望 ${step.code}，收到 ${code}: ${line}`))
          return
        }
        socket.write(step.send())
        staged += 1
        if (staged >= steps.length) {
          if (settled) return
          settled = true
          socket.end()
          resolve({ channel: 'smtp' })
        }
      }
    })
  })
}

/** 飞书自定义机器人（webhook）。成功返回 {channel:'feishu'}。 */
export async function sendFeishu({ subject, text }, config = loadNotifyConfig()) {
  const url = config.feishuWebhook
  if (!url) throw new Error('未配置飞书 webhook')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: `${subject}\n\n${text}` } }),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok || (payload && payload.code && payload.code !== 0)) {
    throw new Error(`飞书返回失败：${res.status} ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return { channel: 'feishu' }
}

/** 兜底：写本地 outbox。成功返回 {channel:'outbox', path}。 */
export function sendOutbox({ subject, text }, dir = 'D:/001/CH002/dsh-memory-data/reports/outbox') {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = `${dir}/${stamp}.md`
  fs.writeFileSync(file, `# ${subject}\n\n${text}\n`, 'utf8')
  return { channel: 'outbox', path: file }
}

/**
 * 逐级兜底发送。永远不抛错，返回 {ok, channel, attempts}。
 */
export async function sendReport({ subject, text }, config = loadNotifyConfig()) {
  const attempts = []
  for (const [name, fn] of [
    ['smtp', () => sendMail({ subject, text }, config)],
    ['feishu', () => sendFeishu({ subject, text }, config)],
    ['outbox', () => Promise.resolve(sendOutbox({ subject, text }))],
  ]) {
    try {
      const result = await fn()
      attempts.push({ channel: name, ok: true })
      return { ok: true, channel: result.channel, path: result.path ?? null, attempts }
    } catch (error) {
      attempts.push({ channel: name, ok: false, error: error.message })
    }
  }
  return { ok: false, channel: null, attempts }
}
