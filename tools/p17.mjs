/** p17：零件库（集市索引快照） */
import { loadCatalog, catalogMeta, searchLibrary } from '../lib/parts/library.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const meta = catalogMeta()
ok('目录有数据', meta.count > 0, String(meta.count))
ok('有来源与时间', Boolean(meta.source) && Boolean(meta.fetchedAt))
ok('有分类统计', Boolean(meta.categories && Object.keys(meta.categories).length > 0), JSON.stringify(meta.categories).slice(0, 120))

const qq = searchLibrary({ query: 'qq', limit: 10 })
ok('搜索 qq 有结果', qq.items.length > 0, String(qq.items.length))
ok('结果带安装命令', qq.items.every((p) => typeof p.install === 'string'))
ok('结果带仓库', qq.items.every((p) => typeof p.repo === 'string'))

const skill = searchLibrary({ category: '技能', limit: 5 })
ok('按分类过滤', skill.items.length > 0 && skill.items.every((p) => p.category === '技能'), String(skill.items.length))

const none = searchLibrary({ query: 'zzzz-not-exist-zzzz', limit: 5 })
ok('无匹配返回空', none.items.length === 0)

const all = searchLibrary({ limit: 1 })
ok('默认按官方审核优先', Boolean(all.items[0].audited), JSON.stringify(all.items[0]).slice(0, 100))

console.log(`\nP17 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
