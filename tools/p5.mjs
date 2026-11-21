// P5 回归：派单状态机 / 台账 / 回执 / 修改权分档（迁移自 luanyujia-workbench 协作机制）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { canWrite } from '../lib/memory/policy.js'
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p5-'))
try {
  const store = new MemoryStore({ dataDir: dir }).open()
  check('schema 升到 v9', store.getMeta('schema_version') === '9', String(store.getMeta('schema_version')))
  check('tasks 表存在', Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()))

  // 四件套
  let missErr = ''
  try {
    store.dispatchCreate({ from: 'A', to: 'B', title: '改索引' })
  } catch (e) {
    missErr = e.message
  }
  check('派单缺四件套被拒', missErr.includes('四件套'), missErr)

  const t = store.dispatchCreate({
    from: 'A', to: 'B', title: '补索引',
    phenomenon: '体检报 3 条未登记', howTo: '照 §6.4', howVerify: '跑体检应 0', deadlineMinutes: 60,
  })
  check('派单创建成功', t.status === 'sent' && t.kind === 'dispatch' && t.deadline_at, JSON.stringify(t))

  // 公告不需要四件套
  const n = store.dispatchCreate({ kind: 'notice', from: 'A', to: 'B', title: '以后这么办' })
  check('公告可只写标题', n.kind === 'notice' && n.status === 'sent')

  // 回执必须带证据
  let evErr = ''
  try {
    store.taskReceipt({ taskId: t.task_id, conclusion: '好了' })
  } catch (e) {
    evErr = e.message
  }
  check('回执缺证据被拒', evErr.includes('证据'), evErr)

  const r = store.taskReceipt({ taskId: t.task_id, conclusion: '已补齐 3 条', evidence: '体检 ⛔0 ⚠0 ✅4', path: 'x/索引.md' })
  check('回执写入成功', r.status === 'acked' && r.ack.evidence.includes('⛔0') && r.messages === 2, JSON.stringify(r))

  // ≤3 条上限
  store.taskReceipt({ taskId: t.task_id, conclusion: '补充', evidence: '再跑一次通过' })
  let capErr = ''
  try {
    store.taskReceipt({ taskId: t.task_id, conclusion: '再来', evidence: 'x' })
  } catch (e) {
    capErr = e.message
  }
  check('同一件事超 3 条被拒', capErr.includes('3 条'), capErr)

  // 状态推进
  const done = store.taskMark({ taskId: t.task_id, status: 'done' })
  check('acked → done 销账', done.status === 'done')
  let bad = ''
  try {
    store.taskMark({ taskId: n.task_id, status: 'done' })
  } catch (e) {
    bad = e.message
  }
  check('只有 acked 能销账', bad.includes('acked'), bad)

  // 台账
  const out = store.taskList({ scene: 'A', scope: 'outbound' })
  const inbound = store.taskList({ scene: 'B', scope: 'inbound' })
  check('台账：我发出没回的', out.length === 1 && out[0].kind === 'notice', JSON.stringify(out.map((x) => x.kind)))
  check('台账：别人等我回的', inbound.length === 1, String(inbound.length))

  // 超时判定
  store.db.prepare("UPDATE tasks SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").run(n.task_id)
  const overdue = store.taskList({ scene: 'A', scope: 'outbound' })
  check('超时未回执被标出', overdue[0].overdue === true && overdue[0].effective_status === 'overdue')

  // 修改权分档
  check('D 档：自己的地盘可写', canWrite({ actor: 'A', target: 'A' }).allowed === true)
  const e = canWrite({ actor: 'A', target: 'B' })
  check('E 档：别人的地盘拒绝', e.allowed === false && e.tier === 'E' && e.request)
  check('A 档：负责人可改', canWrite({ actor: 'owner', target: 'rule', kind: 'rule', ruleOwner: 'owner' }).allowed === true)
  check('A 档：非负责人只能提请求', canWrite({ actor: 'A', target: 'rule', kind: 'rule', ruleOwner: 'owner' }).allowed === false)
  check('B 档：只能写自己的行', canWrite({ actor: 'A', target: 'board', kind: 'board', rowOwner: 'A' }).allowed === true)
  check('B 档：不能写别人的行', canWrite({ actor: 'A', target: 'board', kind: 'board', rowOwner: 'B' }).allowed === false)

  // 工具注册
  const host = { open() {}, injected() { return [] }, closeAll() {} }
  const registry = buildRegistry(store, host)
  for (const name of ['mem_dispatch', 'mem_receipt', 'mem_task', 'mem_scope']) {
    check('注册了 ' + name, registry.has(name))
  }
  const out5 = await registry.get('mem_dispatch').definition.execute({
    from: 'A', to: 'B', title: '工具派单',
    phenomenon: 'p', how_to: 'h', how_verify: 'v',
  })
  check('工具可建派单', out5.status === 'sent' && out5.task_id)

  store.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\nP5 ${fail === 0 ? 'OK' : 'FAILED'}  pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
