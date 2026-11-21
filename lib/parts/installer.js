/**
 * installer.js — 零件的一键安装/卸载（走官方 CLI → pnpm）。
 *
 * 安全边界：
 *   - 只允许 github: / https: / 包名 形式的规格
 *   - 禁止卸载 @deepseek-ai/* 与工作台自身
 *   - 安装后自动把包名登记进 dsh.profile.bundles（否则重启不加载）
 *   - 不执行任意命令，只调 `dsh plugin add/remove`
 *
 * 进度：CLI 输出逐行回调 onProgress，供 jobs.js 生成进度条。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = process.env.DSH_CLI || 'C:/000001/resources/runtime/cli/bin/dsh.cmd'
const CORE_PREFIX = '@deepseek-ai/'
const SELF = 'dsh-sixlayer-memory'
let activeKind = null

export async function resolveNpmName(spec) {
  const m = String(spec).match(/^github:([^/]+)\/(.+)$/)
  if (!m) return null
  const owner = m[1]
  const repo = m[2].replace(/\.git$/, '')
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/package.json`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-sixlayer-memory' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const j = await res.json()
      const pkg = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
      if (typeof pkg.name === 'string' && pkg.name) return pkg.name
    }
  } catch {
    /* 落到搜索 */
  }
  try {
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(repo)}&size=20`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const j = await res.json()
    const target = ('github.com/' + owner + '/' + repo).toLowerCase()
    for (const item of j.objects ?? []) {
      const links = item.package?.links ?? {}
      const link = String(links.repository ?? links.homepage ?? '').toLowerCase()
      if (link.includes(target)) return item.package.name
    }
  } catch {
    /* 忽略 */
  }
  return null
}

async function npmLatest(name) {
  try {
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(name).replace(/^%40/, '@')
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const j = await res.json()
    return (j['dist-tags'] && j['dist-tags'].latest) || null
  } catch {
    return null
  }
}

async function probeCodeload() {
  try {
    const res = await fetch('https://codeload.github.com/', { method: 'HEAD', signal: AbortSignal.timeout(6000) })
    return res.status > 0
  } catch {
    return false
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function runCliStreaming(args, { dshHome, timeoutMs = 180000, onProgress, onChild } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('cmd.exe', ['/c', CLI, ...args], {
        env: { ...process.env, DSH_HOME: dshHome },
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error) })
      return
    }

    onChild?.(child)
    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      if (!finished) {
        finished = true
        resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n[timeout]' })
      }
    }, timeoutMs)

    const feed = (chunk, isErr) => {
      const text = chunk.toString('utf8')
      if (isErr) stderr += text
      else stdout += text
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed) onProgress?.({ line: trimmed })
      }
    }
    child.stdout?.on('data', (c) => feed(c, false))
    child.stderr?.on('data', (c) => feed(c, true))
    child.on('error', (error) => {
      clearTimeout(timer)
      if (!finished) {
        finished = true
        resolve({ ok: false, code: -1, stdout, stderr: String(error) })
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!finished) {
        finished = true
        resolve({ ok: code === 0, code, stdout, stderr })
      }
    })
  })
}

export function resetActive() {
  activeKind = null
}

export function normalizeSpec(item) {
  if (item?.spec) return String(item.spec)
  const repo = String(item?.repo ?? '')
  const m = repo.match(/github\.com\/([^/]+)\/([^/#?]+)/)
  if (m) return `github:${m[1]}/${m[2].replace(/\.git$/, '')}`
  if (repo.startsWith('https://') || repo.startsWith('http://')) return repo
  return null
}

function isSafeSpec(spec) {
  return /^(github:|https?:\/\/|[a-z0-9@][\w.@/-]*$)/i.test(spec) && !spec.includes('..')
}

function deps(profileDir) {
  const pkg = readJson(path.join(profileDir, 'package.json'))
  return Object.keys(pkg.dependencies ?? {})
}

function bundles(profileDir) {
  const pkg = readJson(path.join(profileDir, 'package.json'))
  return pkg.dsh?.profile?.bundles ?? []
}

function addBundle(profileDir, name) {
  const file = path.join(profileDir, 'package.json')
  const pkg = readJson(file)
  const list = pkg.dsh?.profile?.bundles ?? []
  if (!list.includes(name)) list.push(name)
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = { ...(pkg.dsh.profile ?? {}), bundles: list }
  writeJson(file, pkg)
  return list.includes(name)
}

function removeBundle(profileDir, name) {
  const file = path.join(profileDir, 'package.json')
  const pkg = readJson(file)
  const list = (pkg.dsh?.profile?.bundles ?? []).filter((x) => x !== name)
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = { ...(pkg.dsh.profile ?? {}), bundles: list }
  writeJson(file, pkg)
}

export function listInstalled({ dshHome, profile }) {
  const profileDir = path.join(dshHome, 'profiles', profile)
  const names = deps(profileDir)
  const bundleList = bundles(profileDir)
  return names.map((name) => {
    let version = ''
    let description = ''
    try {
      const pkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json'))
      version = pkg.version ?? ''
      description = pkg.description ?? ''
    } catch {
      /* 没装好或不是包 */
    }
    return {
      name,
      version,
      description,
      bundle: bundleList.includes(name),
      removable: name !== SELF && !name.startsWith(CORE_PREFIX),
    }
  })
}

export async function installPart({ item, profile, dshHome, onProgress, registerAbort } = {}) {
  if (activeKind) throw new Error('已有任务在进行（' + activeKind + '），请等它完成或先取消')
  const profileDir = path.join(dshHome, 'profiles', profile)
  const spec = normalizeSpec(item)
  if (!spec) throw new Error('缺少可安装的仓库地址（repo/spec）')
  if (!isSafeSpec(spec)) throw new Error('安装规格不合法：' + spec)
  let effective = spec
  if (spec.startsWith('github:')) {
    onProgress?.({ percent: 4, message: '检查安装通道…' })
    const npmName = await resolveNpmName(spec)
    const latest = npmName ? await npmLatest(npmName) : null
    if (npmName && latest) {
      effective = npmName + '@' + latest
      onProgress?.({ percent: 6, message: 'GitHub 下载通道不通，改用 npm 包：' + effective })
    } else {
      const ok = await probeCodeload()
      if (!ok) throw new Error('本机无法访问 GitHub 下载通道（codeload），且该仓库没有可用的 npm 包。请配置代理，或提供可访问的包名。')
    }
  }

  activeKind = 'install ' + effective
  onProgress?.({ percent: 5, message: '开始安装 ' + spec })
  const before = deps(profileDir)
  const res = await runCliStreaming(['plugin', '--profile', profile, 'add', effective], {
    dshHome,
    onChild: (child) => registerAbort?.(() => { try { child.kill() } catch {} }),
    onProgress: (p) => {
      const line = p.line
      const packages = line.match(/Packages:\s*\+(\d+)/)
      const resolved = line.match(/Progress:\s*resolved\s*(\d+)/)
      if (packages) onProgress?.({ percent: 15, message: '下载依赖 ' + packages[1] + ' 个…' })
      else if (resolved) onProgress?.({ percent: Math.min(80, 15 + Number(resolved[1])), message: '解析依赖 ' + resolved[1] })
      else if (/Done in/.test(line)) onProgress?.({ percent: 85, message: '依赖安装完成' })
      onProgress?.({ line })
    },
  })
  if (!res.ok) {
    activeKind = null
    throw new Error('安装失败：' + (res.stderr || res.stdout).slice(-800))
  }

  const after = deps(profileDir)
  const added = after.find((n) => !before.includes(n)) ?? null
  onProgress?.({ percent: 90, message: '登记 bundle…' })
  let bundleAdded = false
  if (added) bundleAdded = addBundle(profileDir, added)
  onProgress?.({ percent: 100, message: '完成，需要重启' })
  activeKind = null
  return {
    spec: effective,
    package: added,
    bundle: bundleAdded,
    restartRequired: true,
    output: (res.stdout || '').slice(-600),
  }
}

export async function uninstallPart({ name, profile, dshHome, onProgress } = {}) {
  const target = String(name ?? '').trim()
  if (!target) throw new Error('需要包名')
  if (target === SELF) throw new Error('不能卸载工作台自身')
  if (target.startsWith(CORE_PREFIX)) throw new Error('内置包不能卸载：' + target)
  const profileDir = path.join(dshHome, 'profiles', profile)

  onProgress?.({ percent: 5, message: '移除 bundle 登记…' })
  removeBundle(profileDir, target)
  onProgress?.({ percent: 15, message: '开始卸载 ' + target })
  const res = await runCliStreaming(['plugin', '--profile', profile, 'remove', target], {
    dshHome,
    onProgress: (p) => {
      const line = p.line
      const resolved = line.match(/Progress:\s*resolved\s*(\d+)/)
      if (resolved) onProgress?.({ percent: Math.min(85, 20 + Number(resolved[1])), message: '卸载中 ' + resolved[1] })
      else if (/Done in/.test(line)) onProgress?.({ percent: 90, message: '卸载完成' })
      onProgress?.({ line })
    },
  })
  if (!res.ok) throw new Error('卸载失败：' + (res.stderr || res.stdout).slice(-800))
  onProgress?.({ percent: 100, message: '完成，需要重启' })
  return { package: target, restartRequired: true, output: (res.stdout || '').slice(-600) }
}
