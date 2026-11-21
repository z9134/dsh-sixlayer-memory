/** p18：一键安装/卸载的守卫逻辑 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeSpec, listInstalled, uninstallPart } from '../lib/parts/installer.js'

const SELF = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

ok('github 仓库转 spec', normalizeSpec({ repo: 'https://github.com/a/b' }) === 'github:a/b')
ok('带 .git 去掉', normalizeSpec({ repo: 'https://github.com/a/b.git' }) === 'github:a/b')
ok('无 repo 返回 null', normalizeSpec({}) === null)
ok('spec 优先', normalizeSpec({ spec: 'pkg@1.0.0', repo: 'https://github.com/x/y' }) === 'pkg@1.0.0')

const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_home-'))
const profileDir = path.join(dshHome, 'profiles', 'test')
fs.mkdirSync(profileDir, { recursive: true })
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'profile-test',
  dependencies: { [SELF]: 'link:x', '@deepseek-ai/dsh-base': '1.0.0', 'some-plugin': '1.0.0' },
  dsh: { profile: { bundles: [SELF, '@deepseek-ai/dsh-base'] } },
}, null, 2), 'utf8')
fs.mkdirSync(path.join(profileDir, 'node_modules', 'some-plugin'), { recursive: true })
fs.writeFileSync(path.join(profileDir, 'node_modules', 'some-plugin', 'package.json'), JSON.stringify({ name: 'some-plugin', version: '1.0.0', description: 'demo' }), 'utf8')

const list = listInstalled({ dshHome, profile: 'test' })
ok('列出已装', list.length === 3, String(list.length))
const self = list.find((p) => p.name === SELF)
ok('自己不可卸载', self && self.removable === false, 'self=' + String(self?.name ?? 'none') + ' SELF=' + SELF)
const core = list.find((p) => p.name.startsWith('@deepseek-ai/'))
ok('内置不可卸载', core && core.removable === false)
const normal = list.find((p) => p.name === 'some-plugin')
ok('普通插件可卸载', normal && normal.removable === true)
ok('读到版本说明', normal && normal.version === '1.0.0' && normal.description === 'demo')

let threw = false
try { await uninstallPart({ name: SELF, profile: 'test', dshHome }) } catch { threw = true }
ok('卸载自己被拒绝', threw)
threw = false
try { await uninstallPart({ name: '@deepseek-ai/dsh-base', profile: 'test', dshHome }) } catch { threw = true }
ok('卸载内置被拒绝', threw)

console.log(`\nP18 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
