/**
 * scanners.js — 可插拔扫描器链（P2）。
 *
 * 为什么拆出来：
 *  原来扫描规则硬编码在 policy.js 里，命中/误伤无法单独统计。
 *  拆成独立 scanner 后，每条规则可以单独开关、单独统计，
 *  月度回顾才算得出"哪条规则在干活、哪条在误伤"（v3 方案 §3、§6）。
 *
 * 约定：
 *  - 每个 scanner 是纯函数 test(text)，不抛异常；
 *  - kind: injection（越权/注入）| sensitive（凭证/隐私）；
 *  - severity: high | medium（仅用于展示与排序，不参与判定）；
 *  - 新增规则只往数组里加，不改已有 id（历史统计要能对得上）。
 */

export const SCANNERS = [
  // ---------- 注入 / 越权（命中即隔离） ----------
  {
    id: 'ignore-instructions',
    kind: 'injection',
    severity: 'high',
    label: '忽略以上指令',
    test: (s) => /忽略(?:以上|之前|前面|上面).{0,8}(?:指令|要求|设定|规则)/.test(s),
  },
  {
    id: 'ignore-en',
    kind: 'injection',
    severity: 'high',
    label: '忽略以上指令（英文）',
    test: (s) => /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i.test(s),
  },
  {
    id: 'role-hijack',
    kind: 'injection',
    severity: 'high',
    label: '角色劫持',
    test: (s) => /(?:你现在是|从现在起你是|you are now)\s*(?:一个|a\s+)?(?:新的)?\s*(?:管理员|系统|admin|system)/i.test(s),
  },
  {
    id: 'exfiltrate',
    kind: 'injection',
    severity: 'high',
    label: '诱导外发凭证',
    test: (s) => /(?:把|将).{0,12}(?:密钥|密码|token|凭证|私钥).{0,12}(?:发|传|发给|上传|外发)/.test(s),
  },
  {
    id: 'exfil-url',
    kind: 'injection',
    severity: 'high',
    label: '命令里带外链',
    test: (s) => /(?:curl|wget|Invoke-WebRequest).{0,80}https?:\/\//i.test(s),
  },

  // ---------- 凭证 / 隐私（命中即 S 级） ----------
  {
    id: 'password',
    kind: 'sensitive',
    severity: 'high',
    label: '密码/口令',
    test: (s) => /(?:密码|口令|password|passwd|pwd)\s*[:=：是]\s*\S{3,}/i.test(s),
  },
  {
    id: 'api-key',
    kind: 'sensitive',
    severity: 'high',
    label: 'API key / token',
    test: (s) => /(?:api[_-]?key|access[_-]?key|secret|token)\s*[:=：]\s*\S{8,}/i.test(s),
  },
  {
    id: 'private-key',
    kind: 'sensitive',
    severity: 'high',
    label: '私钥块',
    test: (s) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s),
  },
  {
    id: 'gh-token',
    kind: 'sensitive',
    severity: 'high',
    label: 'GitHub token',
    test: (s) => /\bghp_[A-Za-z0-9]{20,}\b/.test(s),
  },
  {
    id: 'sk-token',
    kind: 'sensitive',
    severity: 'high',
    label: 'OpenAI 风格 key',
    test: (s) => /\bsk-[A-Za-z0-9]{20,}\b/.test(s),
  },
  {
    id: 'aws-key',
    kind: 'sensitive',
    severity: 'high',
    label: 'AWS key',
    test: (s) => /\bAKIA[0-9A-Z]{16}\b/.test(s),
  },
  {
    id: 'phone',
    kind: 'sensitive',
    severity: 'medium',
    label: '手机号',
    test: (s) => /(?:^|[^\d])1[3-9]\d{9}(?:[^\d]|$)/.test(s),
  },
  {
    id: 'id-card',
    kind: 'sensitive',
    severity: 'medium',
    label: '身份证号',
    test: (s) => /(?:^|[^\d])\d{17}[\dXx](?:[^\d]|$)/.test(s),
  },
  {
    id: 'bank-card',
    kind: 'sensitive',
    severity: 'medium',
    label: '银行卡号',
    test: (s) => /(?:^|[^\d])\d{16,19}(?:[^\d]|$)/.test(s),
  },
]

/** 按 id 查 scanner（供开关/统计用）。 */
export function scannerById(id) {
  return SCANNERS.find((s) => s.id === id) ?? null
}

/**
 * 跑完整条链。
 * @returns {Array<{id,kind,severity,label}>}
 */
export function runScanners(text) {
  const s = String(text ?? '')
  const hits = []
  for (const scanner of SCANNERS) {
    let hit = false
    try {
      hit = scanner.test(s)
    } catch {
      hit = false
    }
    if (hit) hits.push({ id: scanner.id, kind: scanner.kind, severity: scanner.severity, label: scanner.label })
  }
  return hits
}
