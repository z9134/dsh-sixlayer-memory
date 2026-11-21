/**
 * register-bundle.mjs — 把 dsh-workbench 重新挂回 desktop profile 的 bundles。
 *
 * 只做一件事：在 dsh.profile.bundles 里补回包名（联接已经存在）。
 * 不用 PowerShell 写 JSON（会带 BOM，DSH 启动直接崩），写完立刻重新解析校验。
 */
import fs from 'node:fs'
import path from 'node:path'

const profile = process.env.DSH_PROFILE_DIR ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')
const file = path.join(profile, 'package.json')
const pkgName = 'dsh-workbench'

const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
const json = JSON.parse(raw)
const bundles = json?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) throw new Error('dsh.profile.bundles 不是数组')

if (bundles.includes(pkgName)) {
  console.log(JSON.stringify({ changed: false, message: '已经在 bundles 里', total: bundles.length }))
  process.exit(0)
}

const backup = `${file}.bak-add-${Date.now()}`
fs.copyFileSync(file, backup)
bundles.push(pkgName)

const text = JSON.stringify(json, null, 2)
JSON.parse(text) // 先自证：能解析
fs.writeFileSync(file, text, 'utf8')

// 回读校验：无 BOM、能解析、含包名
const back = fs.readFileSync(file)
if (back[0] === 0xef && back[1] === 0xbb && back[2] === 0xbf) throw new Error('写出的文件带 BOM')
const parsed = JSON.parse(back.toString('utf8'))
if (!parsed.dsh.profile.bundles.includes(pkgName)) throw new Error('回读没看到包名')

console.log(JSON.stringify({ changed: true, backup: path.basename(backup), total: parsed.dsh.profile.bundles.length }))
