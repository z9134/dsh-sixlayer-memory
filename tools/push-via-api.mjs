/**
 * push-via-api.mjs —— 用 GitHub REST API 把本地仓库推到 GitHub。
 *
 * 为什么要这个：这台机器上 github.com:443 不通（git push / GCM 登录都会卡死），
 * 但 api.github.com:443 通。所以走 Git Data API 建库 + 提交树，不依赖 git 传输。
 *
 * 用法：
 *   $env:GITHUB_TOKEN='ghp_xxx'      # classic PAT，勾 repo 权限
 *   node tools/push-via-api.mjs
 *
 * 只读本地 git 索引（git ls-files），不会把 .gitignore 排除的东西传上去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const OWNER = 'z9134'
const REPO = 'dsh-sixlayer-memory'
const ROOT = process.env.REPO_ROOT ?? 'D:/001/CH002/dsh-memory-core'
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN。先在 https://github.com/settings/tokens 建一个勾了 repo 的 token，然后：')
  console.error("  $env:GITHUB_TOKEN='ghp_...'")
  console.error('  node tools/push-via-api.mjs')
  process.exit(2)
}

const API = 'https://api.github.com'

async function callOnce(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-sixlayer-memory-release',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const msg = json?.message ?? text.slice(0, 300)
    throw new Error(`${method} ${url} -> ${res.status} ${msg}`)
  }
  return json
}

/** 网络抖动重试：断线/超时重来 3 次，4xx 直接抛。 */
async function call(method, url, body) {
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await callOnce(method, url, body)
    } catch (error) {
      last = error
      const msg = String(error?.message ?? '')
      const retriable = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|-> 5\d\d/.test(msg)
      if (!retriable) throw error
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt))
    }
  }
  throw last
}

async function ensureRepo() {
  try {
    const repo = await call('GET', `/repos/${OWNER}/${REPO}`)
    console.log(`仓库已存在：${repo.html_url}`)
    return repo
  } catch (error) {
    if (!/-> 404/.test(error.message)) throw error
  }
  const repo = await call('POST', '/user/repos', {
    name: REPO,
    description: '会先审后记、还带审计链的本地记忆 · DSH 六层记忆底座',
    homepage: '',
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  })
  console.log(`已创建仓库：${repo.html_url}`)
  return repo
}

/**
 * 空仓库连 git/trees 都返回 409「Git Repository is empty」，
 * 唯一可靠的办法是先用 Contents API 写一个文件把仓库"点亮"，
 * 再用 blobs/tree/commit 覆盖上去。这里直接写真实 README。
 */
async function bootstrapIfEmpty() {
  try {
    await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
    return false
  } catch (error) {
    if (!/-> 404|-> 409/.test(error.message)) throw error
  }
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'))
  await call('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
    message: 'init: README',
    content: readme.toString('base64'),
  })
  console.log('已用 README 初始化 main 分支（空仓库不能直接传 blob/tree）')
  return true
}

function trackedFiles() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

async function uploadBlob(rel) {
  const abs = path.join(ROOT, rel)
  const content = fs.readFileSync(abs)
  const blob = await call('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  return blob.sha
}

async function main() {
  const me = await call('GET', '/user')
  if (me.login !== OWNER) throw new Error(`token 属于 ${me.login}，不是 ${OWNER}`)
  console.log(`身份：${me.login}`)

  await ensureRepo()
  await bootstrapIfEmpty()

  const files = trackedFiles()
  console.log(`本地文件：${files.length} 个`)

  const entries = []
  let done = 0
  const concurrency = 4
  let cursor = 0
  async function worker() {
    while (cursor < files.length) {
      const rel = files[cursor++]
      const sha = await uploadBlob(rel)
      entries.push({ path: rel.split(path.sep).join('/'), mode: '100644', type: 'blob', sha })
      done += 1
      if (done % 20 === 0) console.log(`  已上传 ${done}/${files.length}`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  console.log(`  已上传 ${done}/${files.length}`)

  const tree = await call('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree: entries })
  const message = execFileSync('git', ['-C', ROOT, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()

  // 有上一次的提交就挂成父提交，让远端历史是线性的（不是每次一个孤儿快照）
  let parents = []
  try {
    const head = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
    if (head?.object?.sha) parents = [head.object.sha]
  } catch {
    /* 首次推送没有父提交 */
  }

  const commit = await call('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `${message}\n\n(经 GitHub API 推送)`,
    tree: tree.sha,
    parents,
  })

  let hasMain = true
  try {
    await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
  } catch (error) {
    if (!/-> 404|-> 409/.test(error.message)) throw error
    hasMain = false
  }
  if (hasMain) {
    await call('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true })
  } else {
    await call('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
  }

  console.log('')
  console.log(`完成：https://github.com/${OWNER}/${REPO}/tree/main`)
  console.log(`commit ${commit.sha.slice(0, 10)} · ${entries.length} 个文件`)
}

main().catch((error) => {
  console.error('失败：' + (error?.message ?? String(error)))
  process.exit(1)
})
