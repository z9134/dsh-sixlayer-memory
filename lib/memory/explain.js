/**
 * explain.js — 把一条记忆翻译成「普通人看得懂的一句话」。
 *
 * 记忆库里存的是工程语言：record_id、层级、`/proc/<pid>/io`、`wchar=0`、
 * 版本号、脚本路径。给用户看的卡片不能原样端上去。
 *
 * 这一层只做**压缩与去术语**，不做改写、不加事实：
 *   - 去掉代码块、内联代码、绝对路径、长哈希、版本号尾巴
 *   - 把「（2026-10-26 实测有效，免拔插）」这类括号里的关键信息提成一句人话
 *   - 按内容分个类（修过的坑 / 定下的规则 / 怎么做 / 聊过的话 / 记下的事实）
 *
 * 纯函数，零依赖，可离线回归（tools/p27.mjs）。
 */

const KINDS = [
  { id: 'chat', label: '聊过的话', test: (t) => /角色[：:]/.test(t) && /用户[：:]/.test(t) },
  { id: 'fix', label: '修过的坑', test: (t) => /(症状|卡死|报错|崩溃|异常|故障|修好|复位|失效|不工作|失败)/.test(t) },
  { id: 'rule', label: '定下的规则', test: (t) => /(一律|统一|默认|以后|今后|禁止|必须|不要|别再|约定|口径|规范)/.test(t) },
  { id: 'howto', label: '怎么做', test: (t) => /(启动|安装|配置|步骤|脚本|命令|接入|部署|流程|用法)/.test(t) },
  { id: 'pref', label: '你的偏好', test: (t) => /(我习惯|我喜欢|我讨厌|我偏好|我一般|我不喜欢)/.test(t) },
  { id: 'fact', label: '记下的事实', test: () => true },
]

/** 去掉行首的装饰符（★ ☆ · • - * > 编号）。 */
function stripMarks(text) {
  return String(text ?? '')
    .replace(/^[\s★☆·•●○\-*>#>]+/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .trim()
}

/** 去术语：代码块 / 内联代码 / 绝对路径 / 长哈希 / URL / 邮箱 / 文件名 / ASCII 标识符。 */
export function cleanText(text) {
  let s = String(text ?? '')
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`([^`]*)`/g, (_, code) => (String(code).length > 24 ? ' ' : String(code)))
  // 工程文件名：wifi_push.py / start.ps1 / config.yaml
  s = s.replace(/\b[\w-]+\.(?:py|ps1|sh|json|ya?ml|md|js|mjs|cjs|ts|log|db|sqlite|exe|bat|ini|conf|txt|csv)\b/gi, ' ')
  // 绝对路径与 Windows 盘符路径
  s = s.replace(/\b[A-Za-z]:\\[^\s，。；、）)]+/g, ' ')
  s = s.replace(/(?:^|[\s（(])\/[\w.\-/<>]{8,}/g, ' ')
  s = s.replace(/\bhttps?:\/\/\S+/g, ' ')
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, ' ')
  s = s.replace(/\b[A-Z0-9]{12,}\b/g, ' ')
  s = s.replace(/\s{2,}/g, ' ')
  s = s.replace(/[（(]\s*[)）]/g, '')
  s = s.replace(/\s+([，。；、])/g, '$1')
  return s.trim()
}

const DATE_RE = /(\d{4})-(\d{1,2})-(\d{1,2})/g

function fmtDate(y, m, d) {
  return `${Number(m)}月${Number(d)}日`
}

/** 相对时间：今天 / 昨天 / N 天前 / 2026 年 10 月 26 日。 */
export function relativeWhen(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return ''
  const day = 86400_000
  const a = new Date(t)
  const b = new Date(now)
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(b) - startOf(a)) / day)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7) return `${diff} 天前`
  if (diff < 30) return `${Math.floor(diff / 7)} 周前`
  if (a.getFullYear() === b.getFullYear()) return fmtDate(a.getFullYear(), a.getMonth() + 1, a.getDate())
  return `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`
}

/**
 * 把括号里的"关键补充"提出来：
 * 「（2026-10-26 实测有效，免拔插）」→ 「10 月 26 日实测有效，免拔插」
 * 只保留含日期/验证/口径这类信息的括号，其它括号（多半是实现细节）丢掉。
 */
function extractNotes(text) {
  const notes = []
  const body = String(text ?? '').replace(/[（(]([^（）()]{2,60})[）)]/g, (whole, inner) => {
    const hasDate = DATE_RE.test(inner)
    DATE_RE.lastIndex = 0
    // 去掉日期之后还剩什么？只有「（2026-10-26）」这种纯日期括号不算补充说明
    const rest = cleanText(inner.replace(DATE_RE, '')).replace(/[，,；;\s]/g, '')
    const meaningful = hasDate || /(实测|验证|定稿|有效|免|口径|注意|默认|必须)/.test(inner)
    if (!meaningful || rest.length === 0) return ' '
    let note = inner.replace(DATE_RE, (_, y, m, d) => fmtDate(y, m, d))
    note = cleanText(note).replace(/\s+/g, '')
    if (note) notes.push(note)
    return ' '
  })
  return { body, notes }
}

/** 收紧空格：中文两侧不留空格，但两个拉丁词之间保留一个。 */
function tighten(text) {
  return String(text ?? '')
    .replace(/\s*([\u4e00-\u9fff（），。；、：！？])\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 句子里找一个自然的截断点。 */
function clamp(text, max) {  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('。'), head.lastIndexOf('、'))
  return (cut > max * 0.5 ? head.slice(0, cut) : head) + '…'
}

/** 分类。 */
export function detectKind(text) {
  const s = String(text ?? '')
  const hit = KINDS.find((k) => k.test(s))
  return hit ?? KINDS[KINDS.length - 1]
}

/** 对话类：用户：X 角色：Y → 说清了"你说过什么、当时怎么回的"。 */
function explainChat(text) {
  const user = text.match(/用户[：:]\s*([^\n]+?)(?:\s*角色[：:]|$)/)
  const reply = text.match(/角色[：:]\s*([^\n]+)/)
  const trimPunct = (s) => String(s ?? '').replace(/[。！？!?；;，,\s]+$/g, '')
  const u = trimPunct(cleanText(user?.[1] ?? '')).slice(0, 40)
  const r = trimPunct(cleanText(reply?.[1] ?? '')).slice(0, 40)
  if (!u && !r) return null
  // 太短的搭话（"对"、"六六六"）不配当标题，归成"随口聊了一句"
  if (u.length < 4) {
    return {
      title: '随口聊了一句',
      plain: r ? `你说了「${u || '几句'}」，回的是「${clamp(r, 26)}」。` : '你说了一句很短的话。',
    }
  }
  return {
    title: `你说过：${clamp(u, 26)}`,
    plain: r ? `它回你：「${clamp(r, 30)}」。` : '',
  }
}

/**
 * 主入口：一条记录 → 给人看的展示信息。
 * title 当标题，plain 只放"补充说明"，不重复标题。
 * @param {{summary?:string, content?:string, created_at?:string, layer?:string}} row
 * @returns {{kind:string, kindId:string, title:string, plain:string, when:string, technical:string}}
 */
export function explainRecord(row, { now = Date.now() } = {}) {
  const raw = String(row?.summary ?? row?.content ?? '').trim()
  const kind = detectKind(raw)
  const fallback = {
    kind: kind.label,
    kindId: kind.id,
    title: clamp(cleanText(raw), 30) || '（没有摘要）',
    plain: '',
    when: relativeWhen(row?.created_at, now),
    technical: raw,
  }
  if (!raw) return fallback

  if (kind.id === 'chat') {
    const chat = explainChat(raw)
    if (chat) return { ...fallback, ...chat }
  }

  const stripped = stripMarks(raw)
  const { body, notes } = extractNotes(stripped)
  const clean = cleanText(body)

  // 「标题：正文」结构：冒号前就是这件事的名字
  const idx = clean.search(/[：:]/)
  const head = idx > 3 ? clean.slice(0, idx) : clean
  const tail = idx > 3 ? clean.slice(idx + 1) : ''

  const title = clamp(head.replace(/[，,。;；]\s*$/, ''), 30) || fallback.title
  const noteText = notes.slice(0, 2).join('，')
  // 尾巴里的实现细节（一堆标识符/符号）就不给用户看了：
  // 去术语后如果掉了太多字、或留下"中文 空格 中文"这种断口，就整段不放。
  const tailClean = cleanText(tail)
  const originalLen = Math.max(1, tail.replace(/\s/g, '').length)
  const keptRatio = tailClean.replace(/\s/g, '').length / originalLen
  const hasSeam = /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(tailClean)
  const tooCodelike = /[\w/]{18,}/.test(tailClean)
  const tailText =
    keptRatio >= 0.5 && !hasSeam && !tooCodelike && tailClean.replace(/\s/g, '').length > 6
      ? clamp(tighten(tailClean), 52)
      : ''
  const plain = [noteText, tailText].filter(Boolean).join('；')

  return { ...fallback, title, plain: plain ? `${plain}。` : '', when: relativeWhen(row?.created_at, now) }
}

/** 批量：给 RPC 返回的行挂上 display。 */
export function decorateRows(rows, options) {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    try {
      return { ...row, display: explainRecord(row, options) }
    } catch {
      return row
    }
  })
}

/** 节点式（graph.all 的 nodes）。 */
export function decorateNodes(nodes, options) {
  return decorateRows(nodes, options)
}
