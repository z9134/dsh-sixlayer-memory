/**
 * recorder.js — 记录仪（append-only + 哈希链）。
 *
 * 设计口径：
 *  - 正文 JSONL 是唯一真源；traces 表只是索引（为了按 trace_id 快速回放）。
 *  - 只追加，不改写：任何"修改"都是新的一行。
 *  - 禁记清单在写入前执行：密码/凭证/PII 一律替换成 «REDACTED:kind»。
 *  - 断链要能查出来：verify() 逐行重算，返回第一个断点。
 *  - 滚动：按月分文件；超过 90 天或 200 MB 从最旧的删。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sha256, nowIso, ensureDir, readJson, writeJson } from './util.js'
import { redact, brief } from './redact.js'

const GENESIS = 'GENESIS'

export class Recorder {
  /**
   * @param {{dir: string, maxBytes?: number, maxDays?: number, onRecord?: Function}} options
   */
  constructor(options) {
    if (!options?.dir) throw new Error('Recorder: dir 必填')
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? 200 * 1024 * 1024
    this.maxDays = options.maxDays ?? 90
    this.onRecord = options.onRecord ?? null
    this.stateFile = path.join(this.dir, '.state.json')
    this.state = { seq: 0, hash: GENESIS }
    this.ready = false
  }

  open() {
    ensureDir(this.dir)
    const saved = readJson(this.stateFile, null)
    if (saved && Number.isFinite(saved.seq)) {
      this.state = { seq: saved.seq, hash: saved.hash || GENESIS }
    }
    this.ready = true
    this.prune()
    return this
  }

  fileFor(date = new Date()) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    return path.join(this.dir, `audit-${y}${m}.jsonl`)
  }

  listFiles() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => /^audit-\d{6}\.jsonl$/.test(f))
        .sort()
        .map((f) => path.join(this.dir, f))
    } catch {
      return []
    }
  }

  /**
   * 追加一条。返回 {seq, hash, trace_id}。
   * @param {{op: string, trace_id?: string, [k: string]: any}} fields
   */
  record(fields) {
    if (!this.ready) this.open()
    const seq = this.state.seq + 1
    const traceId = fields.trace_id ?? `tr-${seq}-${Date.now().toString(36)}`

    // 禁记：query 只留哈希与前 40 字（已脱敏）；其余字段一律过 redact
    const queryRaw = typeof fields.query === 'string' ? fields.query : null
    const safe = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      if (k === 'query') continue
      if (typeof v === 'string') {
        safe[k] = redact(v).text
      } else if (Array.isArray(v)) {
        safe[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? redact(x).text : x))
      } else {
        safe[k] = v
      }
    }
    safe.trace_id = traceId
    if (queryRaw !== null) {
      safe.query_hash = sha256(queryRaw)
      safe.query_preview = brief(redact(queryRaw).text, 40)
    }

    const payload = { seq, at: nowIso(), ...safe }
    const prev = this.state.hash
    const hash = sha256(`${prev}|${JSON.stringify(payload)}`)
    const line = JSON.stringify({ payload, prev, hash })

    fs.appendFileSync(this.fileFor(), `${line}\n`, 'utf8')
    this.state = { seq, hash, at: payload.at }
    writeJson(this.stateFile, this.state)

    try {
      this.onRecord?.(payload, prev, hash)
    } catch {
      /* 索引失败不影响审计写入 */
    }
    return { seq, hash, trace_id: traceId, at: payload.at }
  }

  /** 逐行重算。deep=false 时只校验最后一行与状态是否一致。 */
  verify({ deep = true } = {}) {
    const files = this.listFiles()
    if (files.length === 0) return { ok: true, lines: 0, files: 0, brokenAt: null }

    if (!deep) {
      const last = files[files.length - 1]
      const text = fs.readFileSync(last, 'utf8').trimEnd()
      const lastLine = text.split('\n').pop()
      try {
        const parsed = JSON.parse(lastLine)
        const expect = sha256(`${parsed.prev}|${JSON.stringify(parsed.payload)}`)
        if (expect !== parsed.hash) {
          return { ok: false, lines: this.state.seq, files: files.length, brokenAt: { file: path.basename(last), reason: 'last-hash-mismatch' } }
        }
        if (this.state.hash && parsed.hash !== this.state.hash) {
          return { ok: false, lines: this.state.seq, files: files.length, brokenAt: { file: path.basename(last), reason: 'state-drift' } }
        }
        return { ok: true, lines: this.state.seq, files: files.length, brokenAt: null }
      } catch (error) {
        return { ok: false, lines: this.state.seq, files: files.length, brokenAt: { file: path.basename(last), reason: `unparsable: ${error.message}` } }
      }
    }

    let expectedPrev = GENESIS
    let lines = 0
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8')
      const rows = raw.split('\n').filter((x) => x.trim() !== '')
      for (let i = 0; i < rows.length; i += 1) {
        let parsed
        try {
          parsed = JSON.parse(rows[i])
        } catch (error) {
          return { ok: false, lines, files: files.length, brokenAt: { file: path.basename(file), line: i + 1, reason: `unparsable: ${error.message}` } }
        }
        const expect = sha256(`${parsed.prev}|${JSON.stringify(parsed.payload)}`)
        if (expect !== parsed.hash) {
          return { ok: false, lines, files: files.length, brokenAt: { file: path.basename(file), line: i + 1, reason: 'hash-mismatch' } }
        }
        if (lines > 0 && parsed.prev !== expectedPrev) {
          return { ok: false, lines, files: files.length, brokenAt: { file: path.basename(file), line: i + 1, reason: 'prev-link-mismatch' } }
        }
        expectedPrev = parsed.hash
        lines += 1
      }
    }
    return { ok: true, lines, files: files.length, brokenAt: null }
  }

  /** 按 trace_id 回放（从最新文件往回扫）。 */
  trace(traceId) {
    const id = String(traceId ?? '')
    if (!id) return null
    const files = this.listFiles().reverse()
    for (const file of files) {
      const rows = fs.readFileSync(file, 'utf8').split('\n')
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (!rows[i] || !rows[i].includes(id)) continue
        try {
          const parsed = JSON.parse(rows[i])
          if (parsed.payload?.trace_id === id) {
            return { ...parsed.payload, hash: parsed.hash, prev: parsed.prev, file: path.basename(file) }
          }
        } catch {
          /* 跳过坏行，交给 verify 报 */
        }
      }
    }
    return null
  }

  stats() {
    const files = this.listFiles()
    let bytes = 0
    for (const f of files) {
      try {
        bytes += fs.statSync(f).size
      } catch {
        /* 忽略 */
      }
    }
    return { dir: this.dir, files: files.length, bytes, lastSeq: this.state.seq, lastAt: this.state.at ?? null, maxBytes: this.maxBytes, maxDays: this.maxDays }
  }

  /** 滚动：先按天，再按总量；当前月文件永不删。 */
  prune() {
    const removed = []
    const files = this.listFiles()
    if (files.length === 0) return { removed }
    const current = this.fileFor()
    const cutoff = Date.now() - this.maxDays * 86400_000

    for (const file of files) {
      if (file === current) continue
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file)
          removed.push({ file: path.basename(file), reason: 'older-than-maxDays' })
        }
      } catch {
        /* 忽略 */
      }
    }

    let total = 0
    const sizes = new Map()
    for (const file of this.listFiles()) {
      try {
        const size = fs.statSync(file).size
        sizes.set(file, size)
        total += size
      } catch {
        /* 忽略 */
      }
    }
    while (total > this.maxBytes && sizes.size > 1) {
      const oldest = [...sizes.keys()].sort()[0]
      if (oldest === current) break
      try {
        const size = sizes.get(oldest) ?? 0
        fs.unlinkSync(oldest)
        sizes.delete(oldest)
        total -= size
        removed.push({ file: path.basename(oldest), reason: 'over-maxBytes' })
      } catch {
        break
      }
    }
    return { removed }
  }
}

export default Recorder
