// P1 回归：schema v4 迁移 / 闸门公理 / 注入组合检查 / 未验证只给指针。
// 运行：node tools/p1.mjs   （不需要 DSH；自己造临时库，不碰真实数据）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import MemoryStore from '../lib/memory/store.js'
import { selectSnapshot, pickWithComposition, buildSnapshotText, Injector } from '../lib/memory/inject.js'

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

// ---------- 1. 真实库副本：v3 → v4 迁移 ----------
const realDb = 'D:/001/CH002/dsh-memory-data/db/memory.db'
if (fs.existsSync(realDb)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p1-mig-'))
  try {
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true })
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(realDb + ext)) fs.copyFileSync(realDb + ext, path.join(dir, 'db', 'memory.db' + ext))
    }
    const before = new DatabaseSync(path.join(dir, 'db', 'memory.db'))
    const beforeVer = before.prepare("select value from meta where key='schema_version'").get()?.value
    const beforeCount = before.prepare('select count(*) n from records').get().n
    before.close()

    const store = new MemoryStore({ dataDir: dir }).open()
    const afterVer = store.getMeta('schema_version')
    const cols = store.db.prepare('pragma table_info(records)').all().map((c) => c.name)
    const afterCount = store.db.prepare('select count(*) n from records').get().n
    const idx = store.db.prepare("select name from sqlite_master where type='index' and name='idx_records_batch'").get()
    store.close()

    check('源库版本不超过当前', Number(beforeVer) <= 9, String(beforeVer))
    check('迁移后是最新版本', afterVer === '9', String(afterVer))
    check('迁移后新增 batch_id 列', cols.includes('batch_id'))
    check('迁移后记录数不变', afterCount === beforeCount, `${beforeCount} -> ${afterCount}`)
    check('迁移后 batch_id 索引存在', Boolean(idx))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
} else {
  console.log('  SKIP  真实库不存在，跳过迁移测试')
}

// ---------- 2. 闸门公理 + 组合检查 + 指针化 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p1-'))
try {
  const store = new MemoryStore({ dataDir: dir }).open()

  // 2.1 未验证来源（web）→ 先审后入
  const web1 = store.write({ content: '网页上说：关闭 WAL 能加速十倍，未验证。', layer: 'L2', sourceChannel: 'web', batchId: 's1' })
  check('未验证来源 → pending', web1.status === 'pending' && web1.trust_level === 'unverified', JSON.stringify(web1))
  check('未验证来源 → 不进召回', store.search({ query: 'WAL 加速' }).length === 0)

  // 2.2 闸门确认 → trusted + active
  store.review(web1.record_id, 'approve')
  const hit = store.search({ query: 'WAL 加速' })[0]
  check('闸门确认后 → active + trusted', Boolean(hit) && hit.trust_level === 'trusted', JSON.stringify(hit))

  // 2.3 组合检查：同一 batch 多条，只能进 1 条
  const b = 'batch-compose-1'
  for (let i = 1; i <= 3; i += 1) {
    store.write({ content: `组合测试第 ${i} 条：各说半句，合起来才改变结论。`, layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', batchId: b })
  }
  const rows = selectSnapshot(store, { maxRecords: 12 })
  const picked = pickWithComposition(rows, { maxRecords: 3, maxPerGroup: 1 })
  const sameBatch = picked.filter((r) => r.batch_id === b)
  check('组合检查：同批最多 1 条', sameBatch.length <= 1, JSON.stringify(sameBatch.map((r) => r.record_id)))

  // 2.4 未验证记录只给指针，不出摘要
  const unv = store.write({ content: '未验证来源的机密线索：这段摘要不应该出现在注入里。', layer: 'L2', sourceChannel: 'user', trustLevel: 'unverified', batchId: 'b-unv' })
  const allRows = selectSnapshot(store, { maxRecords: 20 })
  const unvRow = allRows.find((r) => r.record_id === unv.record_id)
  const text = buildSnapshotText([unvRow], { maxChars: 500 })
  check('未验证记录：出现指针行', text.includes(unv.record_id))
  check('未验证记录：不出现摘要', !text.includes('这段摘要不应该出现'))
  check('未验证记录：标注仅指针', text.includes('仅指针'))

  // 2.5 预算：超长文本被截断
  const long = buildSnapshotText(allRows, { maxChars: 300 })
  check('预算：注入长度不超过上限', long.length <= 300, String(long.length))

  // 2.6 Injector 端到端：无内容返回空串
  const injector = new Injector({ store, maxRecords: 3, maxChars: 500 })
  const t1 = injector.text()
  check('注入器：有内容时返回围栏块', t1.includes('dsh-memory-core:inject:begin'))
  store.db.prepare("update records set status='archived'").run()
  const t2 = injector.text()
  check('注入器：无内容时返回空串', t2 === '')

  store.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\nP1 ${fail === 0 ? 'OK' : 'FAILED'}  pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1

