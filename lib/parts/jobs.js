/**
 * jobs.js — 后台任务登记表（安装/卸载的进度来源）。
 *
 * 安装走官方 CLI，可能几十秒到几分钟；阻塞式 RPC 会让 UI 只能转圈。
 * 这里把任务放到内存表里，UI 用 jobId 轮询 progress。
 */
const jobs = new Map()
let seq = 0

/**
 * @param {(progress: (p: {percent?: number, message?: string, phase?: string}) => void) => Promise<any>} runner
 * @returns {{id: string}}
 */
export function startJob(runner) {
  const id = `job-${Date.now()}-${(seq += 1)}`
  const job = {
    id,
    state: 'running',
    percent: 2,
    message: '准备中…',
    phase: 'start',
    lines: [],
    result: null,
    error: null,
    startedAt: Date.now(),
  }
  jobs.set(id, job)

  const progress = (patch) => {
    if (!patch) return
    if (typeof patch.percent === 'number') job.percent = Math.max(job.percent, Math.min(100, Math.round(patch.percent)))
    if (patch.message) job.message = String(patch.message)
    if (patch.phase) job.phase = String(patch.phase)
    if (patch.line) {
      job.lines.push(String(patch.line).slice(0, 300))
      if (job.lines.length > 40) job.lines.shift()
    }
  }

  Promise.resolve()
    .then(() => runner(progress, (abortFn) => { job.abort = abortFn }))
    .then((result) => {
      job.state = 'done'
      job.percent = 100
      job.phase = 'done'
      job.message = '完成'
      job.result = result ?? null
    })
    .catch((error) => {
      job.state = 'error'
      job.phase = 'error'
      const msg = error?.message ?? String(error)
      job.error = msg
      job.message = '失败：' + String(msg).slice(0, 120)
    })
    .finally(() => {
      setTimeout(() => jobs.delete(id), 10 * 60 * 1000).unref?.()
    })

  return { id }
}

export function cancelJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job || job.state !== 'running') return { ok: false, reason: 'not-running' }
  try {
    job.abort?.()
  } catch {
    /* 忽略 */
  }
  job.state = 'cancelled'
  job.phase = 'cancelled'
  job.message = '已取消'
  return { ok: true }
}

export function getJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return null
  return {
    id: job.id,
    state: job.state,
    percent: job.percent,
    phase: job.phase,
    message: job.message,
    lines: job.lines.slice(-12),
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
  }
}
