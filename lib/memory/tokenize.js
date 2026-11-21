/**
 * tokenize.js — 中文 bigram 分词器（零依赖、离线、确定性）。
 *
 * 为什么要它：SQLite FTS5 的 unicode61 分词器把中文整段当成一个 token，
 * 「记忆管理」与「记忆架构」互相检索不到 —— 等于没有 BM25。
 *
 * 做法：CJK 连续片段切成相邻二字组（重叠），拉丁/数字串整体保留。
 *   "记忆管理 v2" → "记忆 忆管 管理 v2"
 *
 * 这不是最优解（jieba 更准），但它是**可替换的**：接口只有 tokenize()，
 * 二期换分词器只需重建索引，不改检索逻辑。
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/
const SEP = /[\s,.;:!?，。；：！？、（）()\[\]{}【】《》"'`~@#$%^&*+=|\\/<>\-_\n\r\t]+/

/** 把文本切成 token 数组。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  let buf = ''

  const flush = () => {
    if (buf) {
      tokens.push(buf)
      buf = ''
    }
  }

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (CJK.test(ch)) {
      // CJK：先冲掉拉丁缓冲，再把连续 CJK 的二字组压进去
      flush()
      let j = i
      let run = ''
      while (j < s.length && CJK.test(s[j])) {
        run += s[j]
        j += 1
      }
      if (run.length === 1) tokens.push(run)
      else for (let k = 0; k < run.length - 1; k += 1) tokens.push(run.slice(k, k + 2))
      i = j - 1
    } else if (SEP.test(ch)) {
      flush()
    } else {
      buf += ch
    }
  }
  flush()

  // 去重保持顺序（FTS 里重复 token 没有意义）
  return [...new Set(tokens)]
}

/** 生成 FTS5 MATCH 表达式：词之间 OR，整体加引号防注入。 */
export function toMatchQuery(text) {
  const tokens = tokenize(text)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/** 供索引写入的正文（空格分隔的 token 串）。 */
export function toIndexedText(text) {
  return tokenize(text).join(' ')
}
