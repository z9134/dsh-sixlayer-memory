/**
 * emotion.js — 确定性情绪标注（零依赖、不调模型）。
 *
 * 认知层的第一块：给每条记忆打上效价（好/坏）和唤醒度（强度），
 * 写入时算一次，之后用于重要性、联想和注入排序。
 *
 * 只做可解释的规则，不做“心理诊断”：
 *   label   neutral / positive / negative / urgent
 *   valence -1..1（负→正）
 *   arousal  0..1（平静→激动）
 *   intensity 0..1（|valence| 与 arousal 的较大者）
 */

const POSITIVE = [
  '感谢', '谢谢', '很好', '不错', '成功', '通过', '完成', '喜欢', '稳定', '修复', '解决',
  '顺利', '满意', '开心', '棒', '赞', '优秀', '可爱', '放心', '一致', '正常', '恢复',
  'thanks', 'thank', 'great', 'good', 'nice', 'success', 'fixed', 'works', 'done', 'ok',
  '开心', '高兴', '爽', '棒', '喜欢', '期待', '激动', '放心', '舒服', '满意',
]

const NEGATIVE = [
  '失败', '报错', '崩溃', '异常', '错误', '卡住', '丢失', '丢了', '坏了', '不行', '无法',
  '拒绝', '担心', '焦虑', '生气', '讨厌', '垃圾', '麻烦', '失望', '难受', '危险', '风险',
  'bug', 'error', 'fail', 'crash', 'broken', 'lost', 'wrong', 'blocked', 'missing', 'bad',
  '难过', '不开心', '心情', '烦', '累', '压力', '焦虑', '难受', '委屈', '生气', '火大', '崩溃', '烦死', '好累',
]

const URGENT = [
  '急', '马上', '立刻', '紧急', '尽快', '赶紧', '现在就要', '火速', '救命',
  'urgent', 'asap', 'immediately', 'critical', 'now',
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * @param {string} text
 * @returns {{label: string, valence: number, arousal: number, intensity: number, hits: {positive: number, negative: number, urgent: number}}}
 */
export function analyzeAffect(text) {
  const body = String(text ?? '').toLowerCase()
  const hits = { positive: 0, negative: 0, urgent: 0 }
  const words = []

  for (const word of POSITIVE) {
    if (body.includes(word)) {
      hits.positive += 1
      words.push(word)
    }
  }
  for (const word of NEGATIVE) {
    if (body.includes(word)) {
      hits.negative += 1
      words.push(word)
    }
  }
  for (const word of URGENT) {
    if (body.includes(word)) {
      hits.urgent += 1
      words.push(word)
    }
  }

  // 感叹号与重复标点也是唤醒信号（最多加 2）
  const bangs = (body.match(/[!！]/g) ?? []).length
  const shout = Math.min(2, bangs)

  const valence = clamp((hits.positive - hits.negative) / 3, -1, 1)
  const arousal = clamp((Math.abs(hits.positive - hits.negative) + hits.urgent * 2 + shout) / 6, 0, 1)

  let label = 'neutral'
  if (hits.urgent > 0 && hits.negative >= hits.positive) label = 'urgent'
  else if (hits.positive > hits.negative) label = 'positive'
  else if (hits.negative > hits.positive) label = 'negative'

  return {
    label,
    valence: round2(valence),
    arousal: round2(arousal),
    intensity: round2(Math.max(Math.abs(valence), arousal)),
    hits,
    words,
  }
}

/**
 * 综合重要性：写入时的初值，后续 mem_judge 会用 beta 继续修正。
 * 0.35 基线 + 情绪 0.35 + 唤醒 0.15 + 层级加成（L2 及以上更“像知识”）。
 */
export function initialImportance(affect, layer = 'L1') {
  const depthBonus = /^L([2-5])$/.test(String(layer)) ? 0.15 : 0
  const value = 0.35 + 0.35 * Math.abs(affect.valence) + 0.15 * affect.arousal + depthBonus
  return round2(clamp(value, 0, 1))
}
