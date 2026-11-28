/**
 * monitor.mjs —— 插件上线后的持续监测（下载量 / star / issue / 市场条目）。
 *
 * 用法：node tools/monitor.mjs            # 默认把状态写到 monitor/state.json
 *       node tools/monitor.mjs --reset    # 重置基线
 *
 * 设计：
 *  - 只读公开接口，不需要任何 token；
 *  - 每个数据源单独 try/catch，一个挂了不影响其它；
 *  - 和上一次的 state.json 做 diff，只说变化，不重复念数字。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const DIR = path.join(ROOT, '..', 'monitor')
const STATE = path.join(DIR, 'state.json')
const HISTORY = path.join(DIR, 'history.jsonl')

const PKG = 'dsh-sixlayer-memory'
const OWNER = 'z9134'
const REPO = 'dsh-sixlayer-memory'
const INDEX_URL = 'https://dsh-market.com/manifest/plugin-market-index.json'

const got = async (url, ms = 15000) => {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'dsh-sixlayer-monitor' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

async function snapshot() {
  const snap = { ts: new Date().toISOString(), npm: null, github: null, market: null, issues: [], pr121: null }

  try {
    const [day, week, range] = await Promise.all([
      got(`https://api.npmjs.org/downloads/point/last-day/${PKG}`),
      got(`https://api.npmjs.org/downloads/point/last-week/${PKG}`),
      got(`https://api.npmjs.org/downloads/range/last-week/${PKG}`),
    ])
    const pkg = await got(`https://registry.npmjs.org/${PKG}`)
    snap.npm = {
      lastDay: day.downloads ?? 0,
      lastWeek: week.downloads ?? 0,
      latest: pkg['dist-tags']?.latest ?? '',
      daily: (range.downloads ?? []).map((d) => ({ day: d.day, n: d.downloads })),
    }
  } catch (error) {
    snap.npm = { error: error.message }
  }

  try {
    const repo = await got(`https://api.github.com/repos/${OWNER}/${REPO}`)
    const issues = await got(`https://api.github.com/repos/${OWNER}/${REPO}/issues?state=open&per_page=20`)
    snap.github = {
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      watchers: repo.subscribers_count ?? 0,
      pushedAt: repo.pushed_at ?? '',
    }
    snap.issues = issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        user: i.user?.login ?? '',
        at: i.created_at,
        body: String(i.body ?? '').replace(/\s+/g, ' ').slice(0, 200),
      }))
  } catch (error) {
    snap.github = { error: error.message }
  }

  // 市场条目的源头 PR（合并后如果有新评论，说明有人对我们这条有话说）
  try {
    const comments = await got('https://api.github.com/repos/zhu1090093659/dsh-community-plugins/issues/121/comments?per_page=50')
    const last = comments[comments.length - 1]
    snap.pr121 = last
      ? { count: comments.length, lastAt: last.created_at, lastBy: last.user?.login ?? '', excerpt: String(last.body ?? '').replace(/\s+/g, ' ').slice(0, 160) }
      : { count: 0 }
  } catch (error) {
    snap.pr121 = { error: error.message }
  }

  try {
    const index = await got(INDEX_URL, 30000)
    const hit = (index.plugins ?? []).find((p) => p.name === PKG)
    snap.market = {
      inIndex: Boolean(hit),
      indexCount: (index.plugins ?? []).length,
      version: hit?.versions?.[0]?.version ?? '',
    }
  } catch (error) {
    snap.market = { error: error.message }
  }

  return snap
}

const bar = (n) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.max(0, Math.round(n)))] ?? ''

function sparkline(daily) {
  if (!daily?.length) return ''
  const max = Math.max(...daily.map((d) => d.n), 1)
  return daily.map((d) => bar((d.n / max) * 7)).join('')
}

function render(prev, cur) {
  const out = []
  const head = `📊 ${new Date(cur.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`

  if (cur.npm && !cur.npm.error) {
    const d = prev?.npm && !prev.npm.error ? cur.npm.lastWeek - prev.npm.lastWeek : null
    const trend = d === null ? '' : d > 0 ? `（+${d}）` : d < 0 ? `（${d}）` : '（持平）'
    out.push(`npm 周下载 ${cur.npm.lastWeek}${trend} · 昨日 ${cur.npm.lastDay} · 版本 ${cur.npm.latest}`)
    const spark = sparkline(cur.npm.daily)
    if (spark) out.push(`近 7 天 ${spark}`)
  } else {
    out.push(`npm 读取失败：${cur.npm?.error ?? '未知'}`)
  }

  if (cur.github && !cur.github.error) {
    const prevStars = prev?.github?.stars
    const starDelta = typeof prevStars === 'number' ? cur.github.stars - prevStars : null
    const starTxt = starDelta === null ? '' : starDelta > 0 ? `（+${starDelta}）` : '（无变化）'
    out.push(`star ${cur.github.stars}${starTxt} · fork ${cur.github.forks} · 打开 issue ${cur.issues.length}`)
  } else {
    out.push(`GitHub 读取失败：${cur.github?.error ?? '未知'}`)
  }

  const prevIssues = new Set((prev?.issues ?? []).map((i) => i.number))
  const fresh = cur.issues.filter((i) => !prevIssues.has(i.number))
  if (fresh.length) {
    out.push(`新 issue ${fresh.length} 条：`)
    for (const i of fresh.slice(0, 5)) {
      out.push(`  #${i.number} ${i.title}（${i.user}）`)
      if (i.body) out.push(`     ${i.body.slice(0, 120)}`)
    }
  } else if (cur.issues.length) {
    out.push(`issue 无新增（${cur.issues.length} 条待处理）`)
  }

  // PR 新评论：合并后还有人说话，往往是要我们改东西
  if (cur.pr121 && !cur.pr121.error) {
    const prevAt = prev?.pr121?.lastAt ?? ''
    if (!prev?.pr121) {
      out.push(`市场 PR 评论 ${cur.pr121.count} 条（基线）`)
    } else if (cur.pr121.lastAt && cur.pr121.lastAt !== prevAt) {
      out.push(`市场 PR 有新评论：${cur.pr121.lastBy}「${cur.pr121.excerpt.slice(0, 90)}」`)
    }
  }

  if (cur.market && !cur.market.error) {
    const changed = prev?.market && !prev.market.error && prev.market.inIndex !== cur.market.inIndex
    const ver = cur.market.version ? ` · 索引版本 ${cur.market.version}` : ''
    out.push(`市场索引 ${cur.market.inIndex ? '在架' : '不在'}${ver}（共 ${cur.market.indexCount} 个插件）${changed ? ' ⚠️ 状态变了' : ''}`)
  } else {
    out.push(`市场索引读取失败：${cur.market?.error ?? '未知'}`)
  }

  return [head, ...out].join('\n')
}

const args = process.argv.slice(2)
if (args.includes('--reset')) {
  fs.rmSync(STATE, { force: true })
  console.log('基线已重置')
}

const prev = loadState()
const cur = await snapshot()
fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(STATE, JSON.stringify(cur, null, 2), 'utf8')
fs.appendFileSync(HISTORY, JSON.stringify({ ts: cur.ts, npm: cur.npm?.lastWeek ?? null, stars: cur.github?.stars ?? null, issues: cur.issues.length }) + '\n', 'utf8')

console.log(render(prev, cur))
