// P6 回归：服务化契约（recall / remember / forget / status）+ 注册行为。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { buildService, SERVICE_API_VERSION } from '../lib/memory/service.js'
import { apply as applyServicePlugin } from '../lib/memory/service-plugin.js'

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

// ---------- 1. 服务契约（直接调用） ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p6-'))
try {
  const store = new MemoryStore({ dataDir: dir }).open()
  const svc = buildService({ store })

  check('apiVersion = 1', svc.apiVersion === SERVICE_API_VERSION)
  check('四个方法都在', ['recall', 'remember', 'forget', 'status'].every((k) => typeof svc[k] === 'function'))
  check('没有暴露 handoff', svc.handoff === undefined)

  // remember：未验证来源 → 走闸门，落 pending
  const w = svc.remember({ content: '插件写入的一条未验证笔记，用于测试闸门。', source: 'web', principal: 'qq:1' })
  check('remember 走写入链（未验证→pending）', w.status === 'pending' && w.trust_level === 'unverified', JSON.stringify(w))

  // 用户来源 → trusted + active
  const u = svc.remember({ content: '用户亲手写的一条记忆，应该直接可信。', source: 'user', principal: 'desktop:owner' })
  check('用户来源可直接落库', u.status === 'active' && u.trust_level === 'trusted', JSON.stringify(u))

  // recall：只给指针，不给正文
  const unvActive = store.write({
    content: '来源未验证但已放行的一条记录，用于测试指针化。',
    sourceChannel: 'user',
    trustLevel: 'unverified',
  })
  const r = svc.recall({ query: '记忆', topK: 10 })
  check('recall 返回 pointers 数组', Array.isArray(r.pointers))
  check('recall 不含 content 字段', r.pointers.every((p) => p.content === undefined))
  const r3 = svc.recall({ query: '指针化', topK: 10 })
  const unvPtr = r3.pointers.find((p) => p.record_id === unvActive.record_id)
  check('未验证来源不给摘要', unvPtr !== undefined && unvPtr.summary === undefined, JSON.stringify(unvPtr))

  // S 级不出现
  const s = store.write({ content: '密码：abcd1234efgh', sourceChannel: 'user', trustLevel: 'trusted' })
  const r2 = svc.recall({ query: '密码', topK: 10 })
  check('S 级不出现在 recall', r2.pointers.every((p) => p.record_id !== s.record_id))

  // group 范围不返回个人记忆
  const g = svc.recall({ query: '记忆', scope: 'group' })
  check('群聊范围返回空', g.pointers.length === 0)

  // forget：归档，不物理删除
  const f = svc.forget({ record_id: u.record_id })
  const still = store.db.prepare('SELECT status FROM records WHERE record_id = ?').get(u.record_id)
  check('forget 只归档不删除', f.status === 'archived' && still && still.status === 'archived', JSON.stringify(f))

  // status：只给摘要
  const st = svc.status()
  check('status 有核心字段', typeof st.records === 'number' && st.audit && st.schemaVersion === '9', JSON.stringify(st))
  check('status 不暴露 dataDir', st.dataDir === undefined)

  // 降级
  const degraded = buildService({ store: null })
  check('无库时 recall 降级', degraded.recall({ query: 'x' }).degraded === true)
  check('无库时 status 降级', degraded.status().degraded === true)

  store.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------- 2. 注册行为（mock ctx） ----------
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p6-ctx-'))
try {
  const provided = {}
  const disposers = []
  const mockCtx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'webServer') return { register: () => () => {} }
      return undefined
    },
    provide(name, value) {
      provided[name] = value
      return () => {}
    },
    effect(fn) {
      const d = fn()
      disposers.push(d)
      return () => {}
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
  }
  applyServicePlugin(mockCtx, { dataDir: dir2 })
  await new Promise(function (r) { setTimeout(r, 30) })
  check('apply 注册了 memory 服务', Boolean(provided.memory), Object.keys(provided).join(','))
  check('注册的服务 apiVersion = 1', provided.memory && provided.memory.apiVersion === 1)
  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      /* 忽略 */
    }
  }
} finally {
  fs.rmSync(dir2, { recursive: true, force: true })
}

console.log(`\nP6 ${fail === 0 ? 'OK' : 'FAILED'}  pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1


