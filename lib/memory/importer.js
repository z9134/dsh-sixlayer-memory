/**
 * importer.js — 旧记忆导入（只读 + 脱敏 + 对账）。
 *
 * 三条铁律：
 *  1. 只读：源文件一个字节都不改；导入是"复制语义"，不是搬家。
 *  2. 脱敏：凭证类正文替换成 «REDACTED:kind»，原值留在原处；该记 S 级。
 *  3. 幂等：按 content_hash 去重，重复跑 imported=0、skipped=N。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redact, brief, looksLikeCredentialDoc } from './redact.js'
import { sha256, normalizeContent, nowIso } from './util.js'
import { toIndexedText } from './tokenize.js'

/** 凭证文档的指针正文：只记"有这份文档、在哪"，不记内容。 */
function buildPointer(item) {
  const title =
    /^title:\s*"?(.+?)"?\s*$/m.exec(item.content)?.[1] ?? path.basename(String(item.ref))
  const desc = /^description:\s*"?(.+?)"?\s*$/m.exec(item.content)?.[1] ?? ''
  return [
    `【指针】${title}`,
    `原文：${item.source}`,
    '状态：S 级；正文含明文凭证，未导入本库（只保留指针）。',
    desc ? `说明：${brief(desc, 160)}` : '',
    '需要原文时人工打开上述文件。',
  ]
    .filter(Boolean)
    .join('\n')
}

export const DEFAULT_LEGACY_HOME = path.join(os.homedir(), '.mnemon')

export class LegacyImporter {
  /**
   * @param {{store: any, home?: string}} options
   */
  constructor({ store, home = DEFAULT_LEGACY_HOME }) {
    this.store = store
    this.home = home
  }

  /** 只读扫描，不改任何东西。 */
  scan() {
    const memory = []
    const documents = []

    const jsonFile = path.join(this.home, 'runtime', 'memories.json')
    if (fs.existsSync(jsonFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
        const entries = Array.isArray(parsed) ? parsed : parsed.entries ?? []
        entries.forEach((entry, index) => {
          if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) return
          memory.push({
            ref: `${path.basename(jsonFile)}#${index}`,
            source: jsonFile,
            target: entry.target ?? 'memory',
            importance: entry.importance ?? null,
            createdAt: entry.created_at ?? null,
            content: entry.content,
          })
        })
      } catch {
        /* 损坏就退回 MEMORY.md */
      }
    }

    // 兜底：memories.json 不可用时从 MEMORY.md 按 § 分隔
    if (memory.length === 0) {
      const mdFile = path.join(this.home, 'runtime', 'MEMORY.md')
      if (fs.existsSync(mdFile)) {
        const parts = fs.readFileSync(mdFile, 'utf8').split(/\n\s*§\s*\n/g)
        parts.forEach((content, index) => {
          if (!content.trim()) return
          memory.push({ ref: `MEMORY.md#${index}`, source: mdFile, target: 'memory', importance: null, createdAt: null, content })
        })
      }
    }

    const docDir = path.join(this.home, 'documents', 'active')
    if (fs.existsSync(docDir)) {
      for (const name of fs.readdirSync(docDir)) {
        if (!name.endsWith('.md')) continue
        const file = path.join(docDir, name)
        try {
          const content = fs.readFileSync(file, 'utf8')
          if (!content.trim()) continue
          documents.push({ ref: `documents/active/${name}`, source: file, target: 'document', importance: null, createdAt: null, content })
        } catch {
          /* 单个文件读失败不阻断整体 */
        }
      }
    }

    return { memory, documents }
  }

  /**
   * 执行导入。dryRun=true 时只算不写。
   */
  run({ dryRun = false } = {}) {
    const { memory, documents } = this.scan()
    const report = {
      home: this.home,
      dry_run: dryRun,
      scanned: { memory: memory.length, documents: documents.length },
      imported: 0,
      skipped: 0,
      redacted: 0,
      by_layer: {},
      redacted_kinds: {},
      errors: [],
      samples: [],
    }

    const all = [
      ...memory.map((x) => ({ ...x, layer: x.target === 'user' ? 'L3' : 'L1', kind: 'memory' })),
      ...documents.map((x) => ({ ...x, layer: 'L3', kind: 'document' })),
    ]

    for (const item of all) {
      try {
        const normalized = normalizeContent(item.content)
        if (!normalized) continue
        const red = redact(normalized)
        const kindCount = red.kinds.length
        if (kindCount > 0) {
          report.redacted += 1
          for (const k of red.kinds) report.redacted_kinds[k] = (report.redacted_kinds[k] ?? 0) + 1
        }

        // 凭证密集的文档不导正文，只导指针 —— 正则永远打不完表格/列表的所有写法
        const pointerOnly = item.kind === 'document' && looksLikeCredentialDoc(red.text, red.kinds)
        const body = pointerOnly ? buildPointer(item, red.text) : red.text
        if (pointerOnly) report.pointer_only = (report.pointer_only ?? 0) + 1

        const tags = ['legacy', item.kind]
        if (item.importance) tags.push(`importance:${item.importance}`)

        // 幂等按来源指针（legacy_ref）判定：同一份源文件只对应一条记录，
        // 脱敏规则升级后重跑会把旧记录就地更新，而不是再插一条新的。
        const existing = this.store.db
          .prepare('SELECT record_id, content_hash FROM records WHERE legacy_ref = ? LIMIT 1')
          .get(item.ref)

        if (existing) {
          if (dryRun) {
            report.skipped += 1
            continue
          }
          if (existing.content_hash === sha256(body)) {
            report.skipped += 1
            continue
          }
          this.store.db
            .prepare('UPDATE records SET content = ?, summary = ?, content_hash = ?, updated_at = ? WHERE record_id = ?')
            .run(body, brief(body, 120), sha256(body), nowIso(), existing.record_id)
          this.store.db.prepare('DELETE FROM records_fts WHERE record_id = ?').run(existing.record_id)
          this.store.db
            .prepare('INSERT INTO records_fts(record_id, body) VALUES(?, ?)')
            .run(existing.record_id, toIndexedText(`${brief(body, 120)}\n${body}`))
          this.store._trace({ op: 'import.update', record_id: existing.record_id, legacy_ref: item.ref })
          report.updated = (report.updated ?? 0) + 1
          continue
        }

        if (dryRun) {
          const exists = this.store.db
            .prepare('SELECT record_id FROM records WHERE content_hash = ? LIMIT 1')
            .get(sha256(body))
          if (exists) report.skipped += 1
          else report.imported += 1
          report.by_layer[item.layer] = (report.by_layer[item.layer] ?? 0) + 1
          if (report.samples.length < 5) {
            report.samples.push({ ref: item.ref, layer: item.layer, redacted: kindCount, pointer_only: pointerOnly, preview: brief(body, 80) })
          }
          continue
        }

        const result = this.store.write({
          content: body,
          layer: item.layer,
          summary: brief(body, 120),
          sourceChannel: 'legacy_import',
          origin: 'legacy_import',
          identityId: 'owner',
          sadLevel: kindCount > 0 ? 'S' : 'A',
          tags,
          legacyRef: item.ref,
          legacySource: item.source,
        })

        if (result.dedup) {
          report.skipped += 1
        } else if (result.skipped) {
          report.errors.push({ ref: item.ref, reason: `沉淀前决策拒绝：${result.reason}` })
        } else {
          report.imported += 1
          report.by_layer[item.layer] = (report.by_layer[item.layer] ?? 0) + 1
        }
        if (report.samples.length < 5) {
          report.samples.push({ ref: item.ref, layer: item.layer, redacted: kindCount, record_id: result.record_id ?? null })
        }
      } catch (error) {
        report.errors.push({ ref: item.ref, reason: error?.message ?? String(error) })
      }
    }

    report.ok = report.errors.length === 0
    return report
  }
}

export default LegacyImporter
