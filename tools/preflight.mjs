#!/usr/bin/env node
/**
 * preflight.mjs — 插件发布/重启前的硬性检查。
 *
 * 为什么要它：这个项目已经因为「BOM」「import 路径」「重复联接」各崩过一次，
 * 每次都是同样几类错误。把教训固化成检查项，改完先跑它，过了再重启。
 *
 * 用法：
 *   node tools/preflight.mjs                        # 检查当前插件
 *   node tools/preflight.mjs --profile <profiledir> # 额外检查 profile 一致性
 *
 * 退出码：0=全过，1=有失败项。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : null
const PROFILE = profileArg ? path.resolve(profileArg) : path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const results = []
function check(id, title, fn) {
  try {
    const detail = fn()
    results.push({ id, title, ok: true, detail: typeof detail === 'string' ? detail : '' })
  } catch (error) {
    results.push({ id, title, ok: false, detail: error?.message ?? String(error) })
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'backup') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function hasBom(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(3)
  const n = fs.readSync(fd, buf, 0, 3, 0)
  fs.closeSync(fd)
  return n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

const pkg = readJson(path.join(ROOT, 'package.json'))

// ---------- G1 编码 ----------
check('G1', '文件无 BOM（JSON/YAML/JS/MD）', () => {
  const files = walk(ROOT).filter((f) => /\.(json|ya?ml|js|mjs|md)$/.test(f))
  const bad = files.filter(hasBom)
  if (bad.length) throw new Error('带 BOM 的文件：\n  ' + bad.map((f) => path.relative(ROOT, f)).join('\n  '))
  return `${files.length} 个文件`
})

// ---------- G2 JSON 可解析 ----------
check('G2', 'JSON 文件可解析（package.json 等）', () => {
  const files = walk(ROOT).filter((f) => f.endsWith('.json'))
  const bad = []
  for (const f of files) {
    try {
      readJson(f)
    } catch (e) {
      bad.push(path.relative(ROOT, f) + ': ' + e.message)
    }
  }
  if (bad.length) throw new Error(bad.join('\n  '))
  return `${files.length} 个 JSON`
})

// ---------- G3 包清单 ----------
check('G3', 'package.json 的 exports/main 指向真实文件', () => {
  const targets = []
  if (typeof pkg.main === 'string') targets.push(pkg.main)
  for (const v of Object.values(pkg.exports ?? {})) {
    if (typeof v === 'string') targets.push(v)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) if (typeof x === 'string') targets.push(x)
  }
  // 支持 exports 里的通配（如 ./locale/*.json）：目录存在且至少有一个匹配文件即可
  const targetExists = (t) => {
    if (!t.includes('*')) return fs.existsSync(path.join(ROOT, t))
    const dir = path.dirname(t)
    const suffix = t.slice(t.lastIndexOf('*') + 1)
    try {
      return fs.readdirSync(path.join(ROOT, dir)).some((f) => f.endsWith(suffix))
    } catch {
      return false
    }
  }
  const missing = targets.filter((t) => !targetExists(t))
  if (missing.length) throw new Error('指向不存在的文件：' + missing.join(', '))
  if (!pkg.dsh?.bundle?.patch) throw new Error('缺少 dsh.bundle.patch')
  const patch = path.join(ROOT, pkg.dsh.bundle.patch)
  if (!fs.existsSync(patch)) throw new Error('bundle patch 不存在：' + pkg.dsh.bundle.patch)
  return `${targets.length} 个入口`
})

// ---------- G4 客户端 bundle ----------
check('G4', '客户端 bundle 自包含且 id 与包名一致', () => {
  const clientPath = path.join(ROOT, 'lib', 'client.js')
  if (!fs.existsSync(clientPath)) return '无客户端 bundle（跳过）'
  const src = fs.readFileSync(clientPath, 'utf8')
  if (/^\s*import\s+/m.test(src)) throw new Error('client.js 含 import 语句（必须自包含）')
  const m = src.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  if (!m) throw new Error('找不到 __ModuleLoader__.load 的 id')
  const expected = pkg.name
  if (m[1] !== expected) throw new Error(`注册 id=${m[1]} 与包名 ${expected} 不一致（会触发 duplicate factory）`)
  return `id=${m[1]}`
})

// ---------- G5 宿主可导入 ----------
check('G5', '宿主模块可导入（import 全部入口）', () => {
  const entries = ['lib/index.js', 'lib/memory/tools.js', 'lib/memory/store.js', 'lib/parts/index.js', 'lib/memory/service-plugin.js']
  const bad = []
  for (const rel of entries) {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) {
      bad.push(rel + ': 不存在')
      continue
    }
    try {
      // 同步检查无法 await，这里用子进程语义：只做路径存在性 + 静态 import 解析
      const src = fs.readFileSync(file, 'utf8')
      const imports = [...src.matchAll(/from\s+'(\.[^']+)'/g)].map((x) => x[1])
      for (const spec of imports) {
        const target = path.resolve(path.dirname(file), spec)
        if (!fs.existsSync(target)) bad.push(`${rel} → ${spec} 不存在`)
      }
    } catch (e) {
      bad.push(rel + ': ' + e.message)
    }
  }
  if (bad.length) throw new Error(bad.join('\n  '))
  return `${entries.length} 个入口的相对导入全部可解析`
})

// ---------- G6 工具注册表 ----------
check('G6', '工具注册表可构建且字段完整', () => {
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
    import MemoryStore from ${JSON.stringify(pathToFileUrl(path.join(ROOT, 'lib/memory/store.js')))}
    import { buildRegistry } from ${JSON.stringify(pathToFileUrl(path.join(ROOT, 'lib/memory/tools.js')))}
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'))
    const store = new MemoryStore({ dataDir: dir }).open()
    const reg = buildRegistry(store, {})
    const bad = []
    for (const [name, item] of reg) {
      const d = item.definition
      if (!d.name || !d.description || !d.parameters || !d.output || typeof d.execute !== 'function') bad.push(name)
    }
    console.log(JSON.stringify({ count: reg.size, bad }))
    store.close()
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim()
  const parsed = JSON.parse(out.split('\n').pop())
  if (parsed.bad.length) throw new Error('字段不完整的工具：' + parsed.bad.join(', '))
  const declared = (pkg.dshx?.contributes?.tools ?? []).length
  const msg = `${parsed.count} 个工具`
  if (declared && declared !== parsed.count) throw new Error(`package.json 声明 ${declared} 个，实际 ${parsed.count} 个`)
  return msg
})

function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/')
}

// ---------- G7 profile 一致性 ----------
check('G7', 'profile 联接唯一（只认包名）、bundles 含本包、patch 无重复 id', () => {
  if (!fs.existsSync(PROFILE)) return 'profile 不存在（跳过）'
  const nm = path.join(PROFILE, 'node_modules')
  const real = (p) => {
    try {
      return fs.realpathSync(p).replace(/\\/g, '/').toLowerCase()
    } catch {
      return null
    }
  }
  const self = real(ROOT)
  const links = fs
    .readdirSync(nm, { withFileTypes: true })
    .filter((e) => real(path.join(nm, e.name)) === self)
    .map((e) => e.name)
  if (links.length === 0) throw new Error(`node_modules 里没有指向本包的联接（应有 ${pkg.name}）`)
  if (links.length > 1) throw new Error('有多个联接指向同一个包，会重复加载：' + links.join(', '))
  if (links[0] !== pkg.name) throw new Error(`联接名 ${links[0]} 与包名 ${pkg.name} 不一致`)
  const profilePkg = readJson(path.join(PROFILE, 'package.json'))
  const bundles = profilePkg.dsh?.profile?.bundles ?? []
  if (!bundles.includes(pkg.name)) throw new Error(`bundles 里没有 ${pkg.name}`)
  const patchFile = path.join(PROFILE, 'cordis.patch.yml')
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '')
    const ids = [...text.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1])
    const seen = new Map()
    const dupIds = []
    for (const id of ids) {
      if (seen.has(id)) dupIds.push(id)
      seen.set(id, true)
    }
    if (dupIds.length) throw new Error('patch 里 id 重复：' + [...new Set(dupIds)].join(', '))
  }
  return `links=${links.join(',')}`
})

// ---------- G8 数据库版本 ----------
check('G8', '库版本不高于代码版本', () => {
  const dataDir = process.env.DSH_MEMORY_DATA_DIR || path.resolve(ROOT, '..', 'dsh-memory-data')
  const dbFile = path.join(dataDir, 'db', 'memory.db')
  if (!fs.existsSync(dbFile)) return '未找到库（跳过）'
  const { SCHEMA_VERSION } = { SCHEMA_VERSION: readSchemaVersion() }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-db-'))
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true })
  fs.copyFileSync(dbFile, path.join(tmp, 'db', 'memory.db'))
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  const script = `
    import MemoryStore from ${JSON.stringify(pathToFileUrl(path.join(ROOT, 'lib/memory/store.js')))}
    const store = new MemoryStore({ dataDir: ${JSON.stringify(tmp)} }).open()
    console.log(store.getMeta('schema_version') ?? '0')
    store.close()
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim()
  const dbVersion = Number(out.split('\n').pop())
  if (dbVersion > SCHEMA_VERSION) throw new Error(`库 v${dbVersion} 高于代码 v${SCHEMA_VERSION}（回退代码会导致降级）`)
  return `库 v${dbVersion} ≤ 代码 v${SCHEMA_VERSION}`
})

// ---------- G9 profile 三处一致 ----------
check('G9', 'profile 三处一致：bundles 含包名 / 联接存在 / patch 行 name 匹配', () => {
  if (!fs.existsSync(PROFILE)) return 'profile 不存在（跳过）'
  const profilePkg = readJson(path.join(PROFILE, 'package.json'))
  const bundles = profilePkg.dsh?.profile?.bundles ?? []
  if (!bundles.includes(pkg.name)) {
    throw new Error(`bundles 里没有 ${pkg.name}（加载器会跳过整个插件，设置里看不到入口）`)
  }
  const link = path.join(PROFILE, 'node_modules', pkg.name)
  if (!fs.existsSync(link)) throw new Error(`缺少联接 node_modules/${pkg.name}`)
  const patchFile = path.join(PROFILE, 'cordis.patch.yml')
  const hasRow = (text, name) => {
    const rows = [...text.replace(/^\uFEFF/, '').matchAll(/- id:\s*(\S+)\s*\n\s*name:\s*'?([^'\n]+)'?/g)]
    return rows.some((r) => r[2].trim() === name)
  }
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8')
    if (hasRow(text, pkg.name)) return 'bundles✓ link✓ patch✓'
  }
  // bundle 自带 patch（package.json 的 dsh.bundle.patch）也算数：
  // 现代安装路径只登记 bundles，行由 bundle 自己的 patch 插入，不再写 profile patch。
  const ownPatch = pkg.dsh?.bundle?.patch ? path.join(ROOT, String(pkg.dsh.bundle.patch)) : null
  if (ownPatch && fs.existsSync(ownPatch) && hasRow(fs.readFileSync(ownPatch, 'utf8'), pkg.name)) {
    return 'bundles✓ link✓ bundle-patch✓'
  }
  throw new Error(`profile patch 和 bundle 自带 patch 里都没有 name: ${pkg.name} 的插入行`)
})

// ---------- G10 客户端 bundle 可注册 ----------
check('G10', '客户端 bundle 在模拟环境可注册（id 正确、apply 存在）', () => {
  const clientPath = path.join(ROOT, 'lib', 'client.js')
  if (!fs.existsSync(clientPath)) return '无客户端 bundle（跳过）'
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  const script = `
    const React = {
      createElement: (...args) => ({ type: 'el', args }),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (v) => ({ current: v }),
      Fragment: 'fragment',
    }
    let captured = null
    globalThis.window = {
      __ModuleLoader__: {
        load: (cfg) => {
          const mod = cfg.factory((name) => (name === 'react' ? React : {}))
          captured = { id: cfg.id, name: mod?.name, hasApply: typeof mod?.apply === 'function' }
        },
      },
    }
    await import(${JSON.stringify(pathToFileUrl(clientPath))})
    console.log(JSON.stringify(captured))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim()
  const parsed = JSON.parse(out.split('\n').pop())
  if (parsed.id !== pkg.name) throw new Error(`注册 id=${parsed.id} 与包名 ${pkg.name} 不一致`)
  if (!parsed.hasApply) throw new Error('客户端模块没有导出 apply')
  return `id=${parsed.id} apply✓`
})

function readSchemaVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'lib/memory/schema.js'), 'utf8')
  const m = src.match(/SCHEMA_VERSION\s*=\s*(\d+)/)
  return m ? Number(m[1]) : 0
}

// ---------- 输出 ----------
let failed = 0
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  if (!r.ok) failed += 1
  console.log(`[${r.id}] ${mark}  ${r.title}${r.detail ? '  — ' + r.detail : ''}`)
}

console.log('')
if (failed === 0) {
  console.log('PREFLIGHT OK — 可以重启/发布。')
  process.exit(0)
}
console.log(`PREFLIGHT FAILED（${failed} 项）— 修完再重启，规则见 docs/插件规范.md`)
process.exit(1)
