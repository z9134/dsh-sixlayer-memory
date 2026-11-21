/**
 * util.js — 纯函数工具：ULID、哈希、时间、路径、JSON 读写。
 * 刻意不引任何第三方包：这个插件要在别人的 host 进程里跑，依赖越少越好。
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ---------- 时间 ----------

/** 本地 ISO 时间（带时区偏移），用于人类阅读与审计。 */
export function nowIso() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 稳定时间戳（UTC ISO），用于排序与哈希。 */
export function nowUtc() {
  return new Date().toISOString()
}

// ---------- ULID ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastTime = -1
let lastRandom = null

/**
 * 单调 ULID：同一毫秒内多次生成也严格递增。
 * 排序即时间序，适合做 record_id / trace_id。
 */
export function ulid(seedTime = Date.now()) {
  let time = seedTime
  if (time <= lastTime) {
    time = lastTime
  }
  let random
  if (time === lastTime && lastRandom) {
    // 同毫秒：在上一份随机数上做 +1（Crockford base32 进位）
    random = lastRandom.slice()
    let i = random.length - 1
    while (i >= 0) {
      if (random[i] === 31) {
        random[i] = 0
        i -= 1
      } else {
        random[i] += 1
        break
      }
    }
  } else {
    random = Array.from(randomBytes(10))
  }
  lastTime = time
  lastRandom = random
  let out = ''
  for (let i = 9; i >= 0; i -= 1) {
    out = CROCKFORD[(time / Math.pow(32, i)) % 32 | 0] + out
  }
  for (let i = 0; i < random.length; i += 1) {
    const byte = random[i]
    out += CROCKFORD[byte & 31] + CROCKFORD[(byte >> 5) & 31]
  }
  return out.slice(0, 26)
}

// ---------- 哈希 ----------

/** 规范化正文：去首尾空白、统一换行、折叠行尾空格。 */
export function normalizeContent(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ---------- 路径 ----------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

// ---------- 数据分级 ----------

/** 凭证类特征：命中即判 S 级（方案 §10：密钥/凭证绝不进自动召回）。 */
const SENSITIVE_PATTERNS = [
  /(?:密码|口令|password|passwd|pwd)\s*[:=：是]\s*\S{3,}/i,
  /(?:api[_-]?key|token|secret|access[_-]?key)\s*[:=：]\s*\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:ssh|vnc)\s*(?:口令|密码|password)?\s*[:=：]?\s*(?:root\/)?\S{6,}/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

export function looksSensitive(text) {
  const s = String(text)
  return SENSITIVE_PATTERNS.some((re) => re.test(s))
}
