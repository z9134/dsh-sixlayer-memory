// P4 回归：场景交接 / 体量体检 / 工具注册（迁移自 luanyujia-workbench 记忆机制）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { buildRegistry } from '../lib/memory/tools.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p4-'))
try {
  const store = new MemoryStore({ dataDir: dir }).open()

  check('schema 升到 v9', store.getMeta('schema_version') === '9', String(store.getMeta('schema_version')))
  const hasTable = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'")
    .get()
  check('handoffs 表存在', Boolean(hasTable))

  // 写 / 读 / 覆盖
  const w1 = store.handoffWrite({ scene: 'memory-core', sections: { last: '完成四期 UI', next: '写五期计划' } })
  check('写入交接', w1.bytes > 0 && w1.sections.next === '写五期计划')
  const r1 = store.handoffRead('memory-core')
  check('读回交接', r1 && r1.sections.last === '完成四期 UI')
  const w2 = store.handoffWrite({ scene: 'memory-core', sections: { next: '只留最新一份' } })
  const r2 = store.handoffRead('memory-core')
  check('覆盖写而不是追加', r2.sections.next === '只留最新一份' && r2.sections.last === undefined, JSON.stringify(r2.sections))

  // 4KB 上限
  let capErr = ''
  try {
    store.handoffWrite({ scene: 'big', sections: { last: 'x'.repeat(5000) } })
  } catch (e) {
    capErr = e.message
  }
  check('交接超 4KB 被拒', capErr.includes('4096'), capErr)

  // 体检
  const c1 = store.checkBudgets('memory-core')
  check('体检通过', c1.ok === true, JSON.stringify(c1.items))
  store.db.prepare("UPDATE handoffs SET bytes = 5000 WHERE scene = 'memory-core'").run()
  const c2 = store.checkBudgets('memory-core')
  check('超线时体检失败', c2.ok === false)

  // 工具注册
  const host = { open() {}, injected() { return [] }, closeAll() {} }
  const registry = buildRegistry(store, host)
  check('注册了 mem_handoff', registry.has('mem_handoff'))
  check('注册了 mem_check', registry.has('mem_check'))
  const wTool = registry.get('mem_handoff').definition
  const out = await wTool.execute({ scene: 'tool-test', mode: 'write', sections: { next: '从工具写入' } })
  check('工具可写交接', out.bytes > 0 && out.scene === 'tool-test', JSON.stringify(out))
  const ro = await wTool.execute({ scene: 'tool-test' })
  check('工具可读交接', ro.text.includes('从工具写入'))

  store.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\nP4 ${fail === 0 ? 'OK' : 'FAILED'}  pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1

