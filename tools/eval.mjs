// eval.mjs — 固定测试集上的扫描器评测（P2）。
// 指标口径对齐 v3 方案 §6：报**工作点**上的误报率与检出率，不报 AUROC。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { scan } from '../lib/memory/policy.js'

const TESTSET = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testset-v1.json')

export function loadTestset(file = TESTSET) {
  const raw = fs.readFileSync(file, 'utf8')
  const data = JSON.parse(raw)
  // 构造方式哈希：同一份样本集合任何时候都能对上号
  const canonical = JSON.stringify(data.samples.map((s) => [s.id, s.level, s.text]))
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
  return { ...data, hash }
}

/**
 * 跑评测。
 * @returns {{testset:{version,hash,count}, normal:{total,flagged,fpr}, levels:object, overall:object, scanners:object}}
 */
export function evaluateScanners(file = TESTSET) {
  const set = loadTestset(file)
  const byLevel = {}
  const scannerHits = {}
  let normalTotal = 0
  let normalFlagged = 0

  for (const sample of set.samples) {
    const result = scan(sample.text)
    const flagged = result.injection.length > 0
    const level = sample.level || 'normal'
    if (!byLevel[level]) byLevel[level] = { total: 0, caught: 0 }
    byLevel[level].total += 1
    if (flagged) byLevel[level].caught += 1
    if (level === 'normal') {
      normalTotal += 1
      if (flagged) normalFlagged += 1
    }
    for (const hit of result.hits || []) {
      scannerHits[hit.id] = (scannerHits[hit.id] || 0) + 1
    }
  }

  const levels = {}
  for (const [level, v] of Object.entries(byLevel)) {
    levels[level] = { total: v.total, caught: v.caught, rate: v.total ? round(v.caught / v.total) : 0 }
  }

  const attacks = (levels.L1?.total || 0) + (levels.L2?.total || 0) + (levels.L3?.total || 0)
  const caught = (levels.L1?.caught || 0) + (levels.L2?.caught || 0) + (levels.L3?.caught || 0)
  const precisionDen = caught + normalFlagged

  return {
    testset: { version: set.version, hash: set.hash, count: set.samples.length },
    normal: { total: normalTotal, flagged: normalFlagged, fpr: normalTotal ? round(normalFlagged / normalTotal) : 0 },
    levels,
    overall: {
      attacks,
      caught,
      recall: attacks ? round(caught / attacks) : 0,
      precision: precisionDen ? round(caught / precisionDen) : 0,
    },
    scanners: scannerHits,
  }
}

function round(x) {
  return Math.round(x * 1000) / 1000
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('eval.mjs')) {
  const r = evaluateScanners()
  console.log(`测试集 ${r.testset.version}  样本 ${r.testset.count}  构造哈希 ${r.testset.hash}`)
  console.log('')
  console.log('级别   样本  检出   检出率')
  for (const [level, v] of Object.entries(r.levels)) {
    console.log(`${level.padEnd(6)} ${String(v.total).padStart(4)} ${String(v.caught).padStart(5)}   ${(v.rate * 100).toFixed(1)}%`)
  }
  console.log('')
  console.log(`误报率 FPR = ${(r.normal.fpr * 100).toFixed(1)}%（${r.normal.flagged}/${r.normal.total}）`)
  console.log(`整体 recall = ${(r.overall.recall * 100).toFixed(1)}%  precision = ${(r.overall.precision * 100).toFixed(1)}%`)
  console.log('')
  console.log('各 scanner 命中次数:', JSON.stringify(r.scanners))
}
