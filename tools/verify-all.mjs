#!/usr/bin/env node
/**
 * verify-all.mjs — 一键跑完全部回归（preflight 之后使用）。
 * 用法：node tools/verify-all.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const toolsDir = path.resolve('tools')
const suites = fs
  .readdirSync(toolsDir)
  .filter((f) => /^(p\d+|write-chain|smoke|phase2|validate-tools)\.mjs$/.test(f))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

let failed = 0
for (const file of suites) {
  try {
    const out = execFileSync(process.execPath, [path.join(toolsDir, file)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lastLine = out.trim().split('\n').filter(Boolean).pop() ?? ''
    console.log(`OK   ${file.padEnd(18)} ${lastLine.replace(/^[A-Z0-9-]+\s*OK\s*/, '')}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${file}`)
    const tail = String(error.stdout ?? '').trim().split('\n').slice(-4).join('\n')
    if (tail) console.log(tail)
  }
}

console.log('')
if (failed === 0) {
  console.log(`VERIFY OK — ${suites.length} 个套件全过。`)
  process.exit(0)
}
console.log(`VERIFY FAILED — ${failed} 个套件失败。`)
process.exit(1)
