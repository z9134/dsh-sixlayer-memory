/**
 * crypto.js — 静态数据加密（四期核心项，默认关闭）。
 *
 * 设计：
 *   - AES-256-GCM，每条记录独立 nonce
 *   - 密钥：dataDir/meta/enc.key（32 字节 hex，仅当前用户可读）
 *   - 密文格式：enc:v1:<iv_b64>:<tag_b64>:<ct_b64>
 *   - 只加密 records.content（摘要/标签保持明文，检索依赖它们）
 *   - 透明解密：store.read 遇到密文自动解；无密钥时返回明确错误，不崩
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PREFIX = 'enc:v1:'
const KEY_FILE = 'enc.key'

export function keyPath(dataDir) {
  return path.join(dataDir, 'meta', KEY_FILE)
}

export function cryptoStatus(dataDir) {
  const file = keyPath(dataDir)
  return { enabled: fs.existsSync(file), keyPath: file }
}

export function loadKey(dataDir) {
  const file = keyPath(dataDir)
  if (!fs.existsSync(file)) return null
  const hex = fs.readFileSync(file, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('enc.key 格式错误：应为 64 位 hex')
  return Buffer.from(hex, 'hex')
}

export function ensureKey(dataDir) {
  const existing = loadKey(dataDir)
  if (existing) return { created: false, key: existing }
  const key = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(keyPath(dataDir)), { recursive: true })
  fs.writeFileSync(keyPath(dataDir), key.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 })
  return { created: true, key }
}

export function isEncrypted(text) {
  return typeof text === 'string' && text.startsWith(PREFIX)
}

export function encryptText(text, key) {
  if (isEncrypted(text)) return text
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(String(text ?? ''), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptText(payload, key) {
  if (!isEncrypted(payload)) return payload
  if (!key) throw new Error('缺少密钥（meta/enc.key）')
  const parts = payload.split(':')
  if (parts.length !== 5) throw new Error('密文格式损坏')
  const iv = Buffer.from(parts[2], 'base64')
  const tag = Buffer.from(parts[3], 'base64')
  const ct = Buffer.from(parts[4], 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
