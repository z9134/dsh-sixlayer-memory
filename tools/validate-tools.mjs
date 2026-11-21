/**
 * validate-tools.mjs — 装进 DSH 之前先把每个工具定义过一遍真实校验器。
 * 用的是 DSH 自己的 assertSupportedJsonSchema（直接从安装目录 import），
 * 所以这里通过 = 重启后 register() 不会因为 schema 形状被拒。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import MemoryStore from '../lib/memory/store.js'
import { buildRegistry } from '../lib/memory/tools.js'

const VENDOR = 'D:/001/Deepseek-Harness-Desktop/Whale Isle/resources/vendor/deepseek-harness'
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(
  pathToFileURL(path.join(VENDOR, 'packages/core/tools/lib/types/json-schema.js')).href
)

/** 递归找 undefined —— 宿主只接受 lossless JSON，含 undefined 的键会整条拒绝。 */
function findUndefined(value, path = 'value') {
  if (value === undefined) return [path]
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return [`${path}（非有限数）`]
    return []
  }
  const hits = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findUndefined(v, `${path}[${i}]`)))
    return hits
  }
  for (const [k, v] of Object.entries(value)) hits.push(...findUndefined(v, `${path}.${k}`))
  return hits
}

/** 校验返回值形状 —— host 会用 additionalProperties:false + lossless JSON 严格卡，离线先卡一遍。 */
function expectValue(toolName, value) {
  const bad = findUndefined(value)
  if (bad.length > 0) throw new Error(`${toolName} 返回值不是 lossless JSON: ${bad.join(', ')}`)
  const violations = validateJsonSchemaValue(registry.get(toolName).definition.output.schema, value, toolName)
  if (violations.length > 0) throw new Error(`${toolName} 返回值不合 schema: ${violations.join('; ')}`)
  return value
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-validate-'))
const store = new MemoryStore({ dataDir, authority: 'shadow' }).open()

let fail = 0
const lines = []

const fakeHost = {
  _injected: new Set(),
  open(names) {
    for (const n of names) this._injected.add(n)
    return this.injected()
  },
  injected() {
    return [...this._injected]
  },
}

const registry = buildRegistry(store, fakeHost)

for (const [name, item] of registry) {
  const def = item.definition
  const problems = []
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(def.name)) problems.push('name 不合法')
  if (typeof def.description !== 'string' || !def.description) problems.push('缺 description')
  if (typeof def.output?.render !== 'function') problems.push('缺 output.render')
  try {
    assertSupportedJsonSchema(def.output.schema)
  } catch (e) {
    problems.push(`output.schema 被拒: ${e.message}`)
  }
  try {
    assertSupportedJsonSchema(def.parameters)
  } catch (e) {
    problems.push(`parameters 被拒: ${e.message}`)
  }
  if (typeof def.execute !== 'function') problems.push('缺 execute')
  if (problems.length) {
    fail += 1
    lines.push(`  FAIL  ${name}  ← ${problems.join('; ')}`)
  } else {
    lines.push(`  PASS  ${name}`)
  }
}

// 行为抽检：目录能跑、空注入被拒、注入后能调用（每个返回值都过 schema 校验）
try {
  const catalog = expectValue('mem_admin_catalog', await registry.get('mem_admin_catalog').definition.execute({}))
  if (!catalog.text.includes('authority')) throw new Error('目录输出里没有 authority')
  lines.push('  PASS  mem_admin_catalog 可执行且输出含 authority')

  let rejected = false
  try {
    await registry.get('mem_admin_open').definition.execute({ tools: [] })
  } catch {
    rejected = true
  }
  lines.push(rejected ? '  PASS  mem_admin_open 拒绝空列表' : (fail += 1, '  FAIL  空列表没被拒绝'))

  const opened = expectValue('mem_admin_open', await registry.get('mem_admin_open').definition.execute({ tools: ['mem_search', 'mem_write'] }))
  lines.push(opened.injected.length === 2 ? '  PASS  open 注入 2 个工具' : (fail += 1, '  FAIL  open 返回不对'))

  const w = expectValue('mem_write', await registry.get('mem_write').definition.execute({ content: '验证：写入一条测试记录', layer: 'L2', source_channel: 'user' }))
  const s = expectValue('mem_search', await registry.get('mem_search').definition.execute({ query: '测试记录' }))
  lines.push(w.record_id && s.count >= 1 ? '  PASS  write→search 闭环' : (fail += 1, `  FAIL  write→search 不通（${JSON.stringify(w)} / ${JSON.stringify(s)}）`))

  const r = expectValue('mem_read', await registry.get('mem_read').definition.execute({ record_id: w.record_id }))
  lines.push(r.record.record_id === w.record_id ? '  PASS  mem_read 读到刚写的那条' : (fail += 1, '  FAIL  mem_read 不对'))

  // S 级拒绝路径：返回值里不能出现 content 键（否则宿主报 not lossless JSON）
  const sec = expectValue('mem_write', await registry.get('mem_write').definition.execute({ content: '测试口令 password: demo-not-real-000', layer: 'L2', source_channel: 'user' }))
  const denied = expectValue('mem_read', await registry.get('mem_read').definition.execute({ record_id: sec.record_id }))
  const denialOk = denied.denied === true && denied.record?.content === undefined && !('content' in (denied.record ?? {}))
  lines.push(denialOk ? '  PASS  S 级拒绝路径：无 content 键、可安全序列化' : (fail += 1, `  FAIL  S 级拒绝路径不对（${JSON.stringify(denied.record)?.slice(0, 120)}）`))

  const secSearch = expectValue('mem_search', await registry.get('mem_search').definition.execute({ query: 'demo-not-real' }))
  const secSearchAll = expectValue('mem_search', await registry.get('mem_search').definition.execute({ query: 'demo-not-real', include_sensitive: true }))
  lines.push(secSearch.count === 0 && secSearchAll.count === 1 ? '  PASS  S 级默认不进检索、显式授权才出' : (fail += 1, `  FAIL  S 级检索过滤不对（${secSearch.count}/${secSearchAll.count}）`))

  const call = expectValue('mem_admin_call', await registry.get('mem_admin_call').definition.execute({ tool: 'mem_read', arguments: { record_id: w.record_id } }))
  lines.push(call.result?.record?.record_id === w.record_id ? '  PASS  admin_call 单次调用' : (fail += 1, `  FAIL  admin_call 不通（${JSON.stringify(call).slice(0, 160)}）`))

  // W2：评分 → 审核 → 待审清单
  const j = expectValue('mem_judge', await registry.get('mem_judge').definition.execute({ record_id: w.record_id, alpha: 0.9, beta: 0.7 }))
  lines.push(j.scored === true && j.beta === '0.7' ? '  PASS  mem_judge 写入 α/β' : (fail += 1, `  FAIL  mem_judge 不对（${JSON.stringify(j)}）`))

  await registry.get('mem_write').definition.execute({ content: '结论：允许关闭写前日志以提速，因为省事。', layer: 'L2', project_id: 'p9', source_channel: 'user' })
  const contra = expectValue('mem_write', await registry.get('mem_write').definition.execute({ content: '结论：禁止关闭写前日志，因为会丢数据。', layer: 'L2', project_id: 'p9', source_channel: 'user' }))
  lines.push(contra.contradiction === true && contra.status === 'pending' ? '  PASS  疑似矛盾 → 待审' : (fail += 1, `  FAIL  矛盾检测没触发（${JSON.stringify(contra)}）`))

  const pend = expectValue('mem_pending', await registry.get('mem_pending').definition.execute({}))
  lines.push(pend.items.some((r) => r.record_id === contra.record_id) ? '  PASS  mem_pending 列出待审' : (fail += 1, '  FAIL  待审清单没列出'))

  const rv = expectValue('mem_review', await registry.get('mem_review').definition.execute({ record_id: contra.record_id, decision: 'approve', note: '验证用' }))
  lines.push(rv.status === 'active' ? '  PASS  mem_review 审核后回到 active' : (fail += 1, `  FAIL  审核没生效（${JSON.stringify(rv)}）`))

  const stub = expectValue('mem_archive', await registry.get('mem_archive').definition.execute({}))
  lines.push(stub.degraded === true ? '  PASS  未实现工具返回 degraded' : (fail += 1, '  FAIL  占位工具没标 degraded'))
} catch (error) {
  fail += 1
  lines.push(`  FAIL  行为抽检异常：${error.message}`)
}

store.close()
fs.rmSync(dataDir, { recursive: true, force: true })

console.log(lines.join('\n'))
console.log(`\n${fail === 0 ? 'TOOLS OK' : 'TOOLS FAILED'}  工具数=${registry.size} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
