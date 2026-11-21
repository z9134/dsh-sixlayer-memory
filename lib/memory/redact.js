/**
 * redact.js — 禁记清单（记录仪与导入器共用）。
 *
 * 原则：**记结构，不记秘密**。命中即替换成 «REDACTED:kind»，
 * 并且原文永远留在它原来的地方（记录仪不存、导入时改指针）。
 */

/** 顺序敏感：先长后短，先具体后泛化。 */
const RULES = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, whole: true },
  { kind: 'gh-token', re: /\bghp_[A-Za-z0-9]{20,}\b/g, whole: true },
  { kind: 'sk-token', re: /\bsk-[A-Za-z0-9]{20,}\b/g, whole: true },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, whole: true },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/g, whole: true },
  // 「密码/口令 xxx」：保留标签，替换值
  { kind: 'password', re: /((?:密码|口令|password|passwd|pwd)\s*[:=：是]?\s*)([^\s，,。；;、）)]{3,})/gi, keep: 1 },
  // root/xxxx（SSH）
  { kind: 'ssh-credential', re: /(root\/)([^\s，,。；;、）)]{4,})/gi, keep: 1 },
  // SSH/VNC 后跟 端口/口令
  { kind: 'remote-credential', re: /((?:ssh|vnc)[^，。;\n]{0,14}?[/：:]\s*)([A-Za-z0-9._\-@]{4,})/gi, keep: 1 },
  // token / secret / api key
  { kind: 'api-key', re: /((?:api[_-]?key|access[_-]?key|token|secret)\s*[:=：]\s*)(\S{8,})/gi, keep: 1 },
  // PII
  { kind: 'phone', re: /(?:^|[^\d])(1[3-9]\d{9})(?:[^\d]|$)/g, whole: false, pii: true },
  { kind: 'id-card', re: /(?:^|[^\d])(\d{17}[\dXx])(?:[^\d]|$)/g, whole: false, pii: true },
]

const SECRET_COL = /密码|口令|password|passwd|token|密钥|secret|credential/i

/**
 * Markdown 表格列级脱敏。
 * 逐行正则抓不到 `| CALP | ch1949101 |` 这种写法 —— 必须认表头、按列替换。
 */
function redactTableColumns(input) {
  const lines = input.split('\n')
  const kinds = []
  let secretCols = []
  let inTable = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      inTable = false
      secretCols = []
      continue
    }
    const cells = line.split('|').slice(1, -1)
    const isSeparator = /^[\s:|-]+$/.test(cells.join(''))
    const isHeader = !isSeparator && cells.some((c) => SECRET_COL.test(c))
    if (isHeader || !inTable) {
      inTable = true
      secretCols = isHeader ? cells.map((c, idx) => (SECRET_COL.test(c) ? idx : -1)).filter((x) => x >= 0) : []
      continue
    }
    if (isSeparator || secretCols.length === 0) continue
    let changed = false
    for (const idx of secretCols) {
      const cell = cells[idx]
      if (idx >= cells.length || !cell || !cell.trim() || /«REDACTED/.test(cell)) continue
      const lead = /^\s*(?:\*\*)?\s*`?/.exec(cell)?.[0] ?? ''
      const tail = /`?\s*(?:\*\*)?\s*$/.exec(cell)?.[0] ?? ''
      cells[idx] = `${lead}«REDACTED:table-cell»${tail}`
      changed = true
      kinds.push('password')
    }
    if (changed) lines[i] = `|${cells.join('|')}|`
  }
  return { text: lines.join('\n'), kinds }
}

/** 凭证密集文档：脱敏命中 ≥2 类，或密码类词出现 ≥3 次。这类不导正文，只导指针。 */
export function looksLikeCredentialDoc(text, kinds = []) {
  if (kinds.length >= 2) return true
  const hits = (String(text ?? '').match(/密码|口令|password|passwd|凭据|credential/gi) ?? []).length
  return hits >= 3
}

/**
 * 替换敏感片段。
 * @returns {{text: string, kinds: string[]}}
 */
export function redact(input) {
  let text = String(input ?? '')
  const kinds = []

  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      // args 末尾是 offset 与整串；捕获组在前
      const groups = args.slice(0, -2)
      kinds.push(rule.kind)
      if (rule.whole) return `«REDACTED:${rule.kind}»`
      if (rule.pii) {
        // 保留边界字符：groups[0] 是前边界，groups[1] 是主体，groups[2] 是后边界
        const before = groups[0] ?? ''
        const after = groups[2] ?? ''
        return `${before}«REDACTED:${rule.kind}»${after}`
      }
      const keep = groups[rule.keep] ?? ''
      return `${keep}«REDACTED:${rule.kind}»`
    })
  }

  // 表格列级（正则抓不到单元格）
  const table = redactTableColumns(text)
  text = table.text
  kinds.push(...table.kinds)

  return { text, kinds: [...new Set(kinds)] }
}

/** 只需要判断"有没有"，不需要替换（导入分级用）。 */
export function detectSensitive(input) {
  return redact(input).kinds
}

/** 一句话摘要：压掉空白，截断。 */
export function brief(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
