/** p21：图查询（edges 构建、BFS 邻域、扩散、边类型过滤） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p21-'))
const store = new MemoryStore({ dataDir: dir }).open()
ok('schema v9', store.getMeta('schema_version') === '9', String(store.getMeta('schema_version')))

const r1 = store.write({ content: '图测试甲：记忆底座排障记录一', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['graph', 'shared'] })
const r2 = store.write({ content: '图测试乙：记忆底座排障记录二', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['shared'] })
const r3 = store.write({ content: '图测试丙：完全独立的另一条记录', layer: 'L2', sourceChannel: 'user', trustLevel: 'trusted', tags: ['lonely'] })

const edgeCount = store.buildEdges()
ok('构建出边', edgeCount > 0, String(edgeCount))

const n1 = store.graphNeighbors(r2.record_id, { hops: 1 })
const ids1 = n1.nodes.map((n) => n.record_id)
ok('一跳到相邻', ids1.includes(r1.record_id), JSON.stringify(ids1))
ok('边带类型', n1.edges.some((e) => e.kind === 'tag'), JSON.stringify(n1.edges))

const n2 = store.graphNeighbors(r3.record_id, { hops: 1 })
ok('孤立节点无边', n2.nodes.length === 1 && n2.edges.length === 0, JSON.stringify(n2.nodes.length))

const t = store.graphTraverse([r1.record_id, r3.record_id], { hops: 2 })
const tids = t.nodes.map((n) => n.record_id)
ok('扩散包含两簇', tids.includes(r1.record_id) && tids.includes(r2.record_id) && tids.includes(r3.record_id), JSON.stringify(tids))
const keys = t.edges.map((e) => e.from + '|' + e.to + '|' + e.kind)
ok('边去重', new Set(keys).size === keys.length)

const batchOnly = store.graphNeighbors(r1.record_id, { hops: 1, edgeTypes: ['batch'] })
ok('边类型过滤', batchOnly.edges.length === 0, String(batchOnly.edges.length))

store.close()
console.log(`\nP21 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)