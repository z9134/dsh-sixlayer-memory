/**
 * detail.js — 「这一条记忆的全部」：正文 + 标签 + 相关记忆 + 人话标题。
 *
 * 面板里点一个圆点，看到的就是这个函数的返回值。
 * 单独拆出来是为了能离线回归（tools/p28.mjs），不用起宿主。
 */
import { explainRecord } from './explain.js'

/**
 * @param {{store:any, recordId:string, includeSensitive?:boolean}} input
 * @returns {object|null}
 */
export function readDetail({ store, recordId, includeSensitive = false } = {}) {
  const id = String(recordId ?? '')
  if (!id) return null
  const row = store.read(id, { includeSensitive })
  if (!row) return null

  let tags = []
  try {
    tags = store.db
      .prepare('SELECT tag FROM tags WHERE record_id = ?')
      .all(id)
      .map((t) => t.tag)
  } catch {
    /* 标签读不到就给空数组 */
  }

  let neighbors = []
  try {
    const assoc = store.associate({ recordId: id, topK: 5 })
    neighbors = (assoc?.items ?? []).map((item) => ({
      record_id: item.record_id,
      title: explainRecord({ summary: item.summary }).title,
      reasons: item.reasons ?? [],
      weight: item.weight ?? null,
    }))
  } catch {
    /* 联想失败不影响详情 */
  }

  return { ...row, tags, neighbors, display: explainRecord(row) }
}
