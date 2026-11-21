/**
 * affect-alert.js — 情绪提醒（三期）。
 *
 * 两种提醒：
 *   1. 注入提示：最近 N 小时负面/紧急偏多时，注入一行「情绪提示」，影响 agent 语气
 *   2. 主动通知：同一次尖峰只通知一次（默认 6 小时冷却），走现有邮件/飞书通道
 */

const NEGATIVE = ['negative', 'urgent']

export function affectSpike(store, { hours = 3, threshold = 2 } = {}) {
  const since = new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString()
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM affect_events WHERE occurred_at >= ? AND label IN ('negative','urgent')")
    .get(since)
  return {
    spike: Number(row?.n ?? 0) >= Number(threshold),
    count: Number(row?.n ?? 0),
    hours: Number(hours),
    threshold: Number(threshold),
    since,
  }
}

/** 注入用的一行提示；没有尖峰返回空串。 */
export function affectHint(store, options = {}) {
  try {
    const s = affectSpike(store, options)
    if (!s.spike) return ''
    return `> 情绪提示：近 ${s.hours} 小时负面/紧急消息 ${s.count} 条。先安抚再解决，语气放慢，不追问细节。`
  } catch {
    return ''
  }
}

/**
 * 主动通知：尖峰时发一封邮件/飞书（同一尖峰冷却默认 6 小时）。
 * @returns {Promise<{sent: boolean, reason?: string, channel?: string}>}
 */
export async function notifyAffectSpike({ store, notify, options = {}, cooldownMs = 6 * 3600 * 1000 } = {}) {
  const s = affectSpike(store, options)
  if (!s.spike) return { sent: false, reason: 'no-spike' }
  if (!notify) return { sent: false, reason: 'notify-unavailable' }

  const last = store.getMeta('affect_last_notify') ?? ''
  if (last && Date.now() - Number(last) < cooldownMs) return { sent: false, reason: 'cooldown' }

  const text = [
    `近 ${s.hours} 小时检测到负面/紧急消息 ${s.count} 条（阈值 ${s.threshold}）。`,
    '',
    '可以去工作台 → 观测 → 今日情绪事件查看明细。',
  ].join('\n')
  try {
    await notify({ subject: '情绪提醒：最近负面偏多', text })
    store.setMeta('affect_last_notify', String(Date.now()))
    return { sent: true, channel: 'notify' }
  } catch (error) {
    return { sent: false, reason: error?.message ?? String(error) }
  }
}
