/** p16：mem_resume（未完成任务续跑） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { buildRegistry } from '../lib/memory/tools.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p16-'))
  const store = new MemoryStore({ dataDir: dir }).open()
  const t = store.dispatchCreate({ from: 'desk', to: 'workbench', title: '整理发布流程', phenomenon: '文档还没写', howTo: '写 README + 安装说明', howVerify: '链接可点' })
  store.handoffWrite({ scene: 'workbench', title: '交接：发布', sections: { last: '上次做到 README 已重写', next: '写安装说明' } })

  const registry = buildRegistry(store, {})
  const tool = registry.get('mem_resume')?.definition
  ok('mem_resume 已注册', Boolean(tool))
  const out = await tool.execute({ scene: 'workbench' })
  ok('列出未完成任务', out.text.includes('整理发布流程'), out.text.slice(0, 200))
  ok('带现象/做法/验收', out.text.includes('现象') && out.text.includes('做法') && out.text.includes('验收'))
  ok('带交接内容', out.text.includes('上次做到'), out.text.slice(0, 300))
  ok('返回结构化 tasks', Array.isArray(out.tasks) && out.tasks.length === 1)

  const outAll = await tool.execute({})
  ok('不传 scene 也能列任务', outAll.text.includes('整理发布流程'))

  store.db.prepare("UPDATE tasks SET status = 'done' WHERE task_id = ?").run(t.task_id)
  const outDone = await tool.execute({ scene: 'workbench' })
  ok('完成后不再列出', outDone.text.includes('没有未完成的任务'), outDone.text.slice(0, 120))

  store.close()
} catch (error) {
  fail += 1
  console.log('  THREW ' + (error?.message ?? String(error)))
}

console.log(`\nP16 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)