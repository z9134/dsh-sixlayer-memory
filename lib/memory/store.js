/**
 * store.js — 六层记忆库：打开/迁移/写入链/检索/评分/审核/不变量/快照。
 *
 * 设计约束（来自方案）：
 *  - 只增不删：本文件不提供物理删除；archive 只是改 layer/depth（二期）。
 *  - 失败即显式：低价值不落库要说出原因，降级要说清理由，不伪造数据。
 *  - 写入不静默覆盖：重复内容返回既有 record_id（dedup），疑似冲突标记后交调用方。
 *  - S 级不进自动召回；tainted 进隔离区；pending 需人工审核后才参与召回。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DDL, SCHEMA_VERSION, MIGRATIONS } from './schema.js'
import { cryptoStatus as cryptoInfo, ensureKey, loadKey, isEncrypted, encryptText, decryptText } from './crypto.js'
import { normalizeContent, sha256, nowIso, nowUtc, ulid, ensureDir } from './util.js'
import { toIndexedText, toMatchQuery } from './tokenize.js'
import {
  resolveTrust,
  weakerTrust,
  scan,
  lowValueReason,
  classifySAD,
  similarity,
  contradictionSuspect,
  usageCaveat,
} from './policy.js'
import { Recorder } from './recorder.js'
import { LegacyImporter } from './importer.js'
import { LegacyIndex, shadowCompare } from './shadow.js'
import { analyzeAffect, initialImportance } from './emotion.js'

export const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
export const SAD = ['S', 'A', 'D']
export const TRUST = ['trusted', 'unverified', 'tainted']
export const AUTHORITY = ['legacy', 'shadow', 'new']
export const REVIEW_DECISIONS = ['approve', 'reject', 'release']

/**
 * 判定"说的是同一件事"的相似度阈值。
 * 实测标定（lib/policy.js 的 bigram Jaccard）：
 *   结论相反的同话题句 0.438 · 同话题不同细节 0.636 · 同话题无关内容 0.190
 * 取 0.35：把 0.438 这类"结论相反"捞出来，0.19 这类噪音挡在外面。
 * 阈值偏低时只会多出"待审"，不会误删——代价可控。
 */
const SIMILARITY_THRESHOLD = 0.35

export class MemoryStore {
  /**
   * @param {{dataDir: string, authority?: string, snapshotIntervalMs?: number}} options
   */
  constructor(options) {
    if (!options || !options.dataDir) throw new Error('MemoryStore: dataDir 必填')
    this.dataDir = options.dataDir
    this.dbDir = path.join(this.dataDir, 'db')
    this.backupDir = path.join(this.dataDir, 'backup')
    this.dbFile = path.join(this.dbDir, 'memory.db')
    this.auditDir = path.join(this.dataDir, 'audit')
    this.recorder = null
    this.auditHealth = { ok: null, lines: 0, brokenAt: null }
    this.authority = AUTHORITY.includes(options.authority) ? options.authority : 'shadow'
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 24 * 60 * 60 * 1000
    this.db = null
    this.openedAt = null
  }

  // ---------- 生命周期 ----------

  open() {
    if (this.db) return this
    ensureDir(this.dbDir)
    ensureDir(this.backupDir)
    ensureDir(path.join(this.dataDir, 'audit'))
    ensureDir(path.join(this.dataDir, 'meta'))

    this.db = new DatabaseSync(this.dbFile)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(DDL)

    const raw = this.getMeta('schema_version')
    if (raw === null) {
      this.setMeta('schema_version', String(SCHEMA_VERSION))
      this.setMeta('created_at', nowIso())
    } else {
      const version = Number(raw)
      if (!Number.isFinite(version)) throw new Error(`MemoryStore: schema_version 不是数字（${raw}）`)
      if (version > SCHEMA_VERSION) {
        throw new Error(`MemoryStore: 库版本 v${version} 高于代码 v${SCHEMA_VERSION}，请升级插件再打开（不做降级迁移）`)
      }
      if (version < SCHEMA_VERSION) this.migrate(version)
    }
    // batch_id 索引放在迁移之后建：旧库先 ALTER 加列，再建索引；新库直接建。
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_records_batch ON records(batch_id)')
    } catch {
      /* 索引失败不阻断打开 */
    }
    if (this.getMeta('authority') === null) this.setMeta('authority', this.authority)

    // 记录仪：JSONL 是 append-only 真源，traces 表是索引
    this.recorder = new Recorder({
      dir: this.auditDir,
      onRecord: (payload, prev, hash) => {
        try {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO traces (
                 trace_id, seq, at, op, principal_id, query_hash, query_preview, hits, injected,
                 tokens_in, tokens_out, duration_ms, prev_hash, hash
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              payload.trace_id,
              payload.seq,
              payload.at,
              payload.op ?? 'unknown',
              payload.principal_id ?? null,
              payload.query_hash ?? null,
              payload.query_preview ?? null,
              JSON.stringify(payload.hits ?? []),
              JSON.stringify(payload.injected ?? []),
              payload.tokens_in ?? null,
              payload.tokens_out ?? null,
              payload.duration_ms ?? null,
              prev,
              hash,
            )
        } catch {
          /* 索引写失败不影响审计 */
        }
      },
    }).open()

    // 启动体检：只校验最后一行与状态是否一致（全量校验走 mem_audit --deep）
    this.auditHealth = this.recorder.verify({ deep: false })

    this.openedAt = nowUtc()
    this.maybeSnapshot()
    return this
  }

  /** 逐版本升级；ADD COLUMN 不幂等，所以先查 pragma 再执行。 */
  migrate(from) {
    for (let v = from + 1; v <= SCHEMA_VERSION; v += 1) {
      const steps = MIGRATIONS[v]
      if (!steps) throw new Error(`MemoryStore: 缺少 v${v} 的迁移脚本`)
      for (const step of steps) {
        const cols = this.db.prepare(`PRAGMA table_info(${step.table})`).all().map((c) => c.name)
        if (!cols.includes(step.column)) this.db.exec(step.sql)
      }
      this.setMeta('schema_version', String(v))
      this.setMeta(`migrated_to_v${v}_at`, nowIso())
    }
  }

  close() {
    if (!this.db) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* 忽略：关闭阶段不允许抛 */
    }
    this.db.close()
    this.db = null
  }

  // ---------- meta ----------

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  // ---------- 权限/权威开关 ----------

  getAuthority() {
    return this.getMeta('authority') ?? this.authority
  }

  setAuthority(value) {
    if (!AUTHORITY.includes(value)) throw new Error(`authority 只能是 ${AUTHORITY.join(' / ')}`)
    this.setMeta('authority', value)
    this.setMeta('authority_changed_at', nowIso())
    return value
  }

  // ---------- 写入 ----------

  /**
   * 写入一条记忆（方案 §14 的 a–h）。
   *
   * 顺序：信任判定 → 投毒扫描 → 沉淀前决策 → 分级 → 去重 → 冲突/矛盾 → 落库（含待审标记）。
   * 不抛"业务拒绝"，用返回值说清楚：skipped / dedup / conflict / contradiction。
   */
  write(input) {
    const t0 = Date.now()
    const result = this._writeInternal(input)
    this._trace({
      op: result.dedup ? 'write.dedup' : result.skipped ? 'write.skipped' : 'write',
      record_id: result.record_id ?? '',
      layer: result.layer,
      sad_level: result.sad_level,
      trust_level: result.trust_level,
      status: result.status,
      dedup: result.dedup,
      skipped: result.skipped,
      scanned: result.scanned ?? [],
      principal_id: input?.identityId ?? input?.principalId ?? null,
      duration_ms: Date.now() - t0,
    })
    return result
  }

  _trace(fields) {
    try {
      return this.recorder?.record(fields) ?? null
    } catch {
      return null
    }
  }

  /**
   * 公开记录入口：给注入器等外部模块写审计用（P2 修）。
   * 之前 inject.js 调的是 store.record()，但本类没有这个方法 —— 注入审计一直在静默丢失。
   */
  record(fields) {
    return this._trace(fields ?? {})
  }

  _writeInternal(input) {
    const content = normalizeContent(input.content ?? '')
    if (!content) throw new Error('write: content 不能为空')
    if (content.length > 200_000) throw new Error('write: content 超过 200k 字符，请先摘要')

    const layer = LAYERS.includes(input.layer) ? input.layer : 'L2'
    const sourceChannel = input.sourceChannel ?? input.source_channel ?? 'unknown'
    const identityId = input.identityId ?? input.identity_id ?? (input.principalId ? 'owner' : 'agent')
    const hash = sha256(content)

    // a. 信任判定：通道 × 身份；显式传入优先（但不会高于 trusted）
    let trustLevel = TRUST.includes(input.trustLevel)
      ? input.trustLevel
      : resolveTrust({ channel: sourceChannel, principalId: identityId })

    // b. 投毒扫描
    const scanned = scan(content)
    if (scanned.injection.length > 0) trustLevel = weakerTrust(trustLevel, 'tainted')

    // c. 沉淀前决策：低价值不落库（用户显式写入永远保留；显式调用也保留）
    const skipReason = input.explicit === true ? null : lowValueReason(content, sourceChannel)
    if (skipReason) {
      return {
        record_id: null,
        dedup: false,
        skipped: true,
        reason: skipReason,
        layer,
        sad_level: 'A',
        trust_level: trustLevel,
        status: 'skipped',
        conflict: false,
        conflict_of: null,
        contradiction: false,
        scanned: scanned.flags,
      }
    }

    // e. 去重：内容寻址
    const existing = this.db
      .prepare("SELECT * FROM records WHERE content_hash = ? AND status != 'quarantined' LIMIT 1")
      .get(hash)
    if (existing) {
      return {
        record_id: existing.record_id,
        dedup: true,
        skipped: false,
        reason: '',
        layer: existing.layer,
        sad_level: existing.sad_level,
        trust_level: existing.trust_level,
        status: existing.status,
        conflict: Boolean(existing.conflict_of),
        conflict_of: existing.conflict_of ?? null,
        contradiction: false,
        scanned: scanned.flags,
      }
    }

    // f. 分级
    const sadLevel = classifySAD({ flags: scanned.flags, explicit: input.sadLevel })

    // g. 冲突与矛盾：同项目同层里"说的是同一件事"的既有记录
    const candidates = this.db
      .prepare(
        `SELECT record_id, content FROM records
          WHERE layer = ? AND status IN ('active','pending')
            AND (project_id IS ? OR project_id = ?)
          ORDER BY created_at DESC LIMIT 50`,
      )
      .all(layer, input.projectId ?? null, input.projectId ?? null)

    let conflictOf = null
    let contradiction = false
    for (const row of candidates) {
      const sim = similarity(content, row.content)
      if (sim >= SIMILARITY_THRESHOLD) {
        if (conflictOf === null) conflictOf = row.record_id
        if (contradictionSuspect(content, row.content)) contradiction = true
      }
      if (conflictOf !== null && contradiction) break
    }

    // h. 状态：投毒→隔离；未验证来源→过闸门待审；疑似矛盾→待审；其余→active
    const origin = input.origin ?? 'manual'
    const batchId = input.batchId ?? input.batch_id ?? input.sessionId ?? null
    const tainted = trustLevel === 'tainted'
    let status = tainted ? 'quarantined' : 'active'
    let pendingReview = 0
    let reviewReason = 'contradiction-suspect'
    // 闸门公理（P1）：只有用户亲手输入、或已在闸门确认过的才可信。
    // 旧记忆导入是用户自己的数据，不重复过闸；其余非用户直输一律先审后入。
    if (!tainted && trustLevel !== 'trusted' && sourceChannel !== 'user' && origin !== 'legacy_import') {
      status = 'pending'
      pendingReview = 1
      reviewReason = 'unverified-source'
    }
    if (contradiction && !tainted) {
      status = 'pending'
      pendingReview = 1
      if (reviewReason !== 'unverified-source') reviewReason = 'contradiction-suspect'
    }

    const recordId = ulid()
    const now = nowIso()
    const summary = input.summary ?? content.slice(0, 120).replace(/\s+/g, ' ')
    // 认知层：写入时算一次情绪；重要性用情绪 + 层级给初值，后续 beta 继续修正
    const affect = analyzeAffect(content)
    const importance = initialImportance(affect, layer)

    this.db
      .prepare(
        `INSERT INTO records (
           record_id, layer, depth, content, summary, content_hash, sad_level, trust_level,
           source_channel, origin, principal_id, identity_id, project_id, session_id,
           alpha, beta, scored, status, pending_review, conflict_of, scan_result,
           legacy_ref, legacy_source, batch_id, affect_label, affect_valence, affect_arousal,
           importance, created_at, updated_at
         ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recordId,
        layer,
        content,
        summary,
        hash,
        sadLevel,
        trustLevel,
        sourceChannel,
        origin,
        input.principalId ?? null,
        identityId,
        input.projectId ?? null,
        input.sessionId ?? null,
        status,
        pendingReview,
        conflictOf,
        JSON.stringify(scanned),
        input.legacyRef ?? null,
        input.legacySource ?? null,
        batchId,
        affect.label,
        affect.valence,
        affect.arousal,
        importance,
        now,
        now,
      )

    this.db.prepare('INSERT INTO records_fts(record_id, body) VALUES(?, ?)').run(recordId, toIndexedText(`${summary}\n${content}`))

    for (const tag of Array.isArray(input.tags) ? input.tags : []) {
      this.db.prepare('INSERT OR IGNORE INTO tags(record_id, tag) VALUES(?, ?)').run(recordId, String(tag))
    }

    if (pendingReview === 1) {
      this.db
        .prepare('INSERT OR REPLACE INTO review_queue(record_id, reason, created_at) VALUES(?, ?, ?)')
        .run(recordId, reviewReason, now)
    }

    return {
      record_id: recordId,
      dedup: false,
      skipped: false,
      reason: '',
      layer,
      sad_level: sadLevel,
      trust_level: trustLevel,
      status,
      conflict: conflictOf !== null,
      conflict_of: conflictOf,
      contradiction,
      scanned: scanned.flags,
    }
  }

  // ---------- 评分（非阻塞） ----------

  /**
   * 补评 α（0.01–1）与 β（0–1）。未评分的记录可以召回，但注入时带"未评分"标记（方案 §15）。
   */
  judge(recordId, { alpha, beta } = {}) {
    const row = this.db.prepare('SELECT record_id, alpha, beta FROM records WHERE record_id = ?').get(recordId)
    if (!row) throw new Error(`judge: 没有记录 ${recordId}`)
    const a = alpha === undefined || alpha === null ? row.alpha : Number(alpha)
    const b = beta === undefined || beta === null ? row.beta : Number(beta)
    if (a !== null && (!Number.isFinite(a) || a < 0.01 || a > 1)) throw new Error('judge: alpha 必须在 0.01–1 之间')
    if (b !== null && (!Number.isFinite(b) || b < 0 || b > 1)) throw new Error('judge: beta 必须在 0–1 之间')
    if (a === null && b === null) throw new Error('judge: alpha / beta 至少要给一个')

    this.db
      .prepare('UPDATE records SET alpha = ?, beta = ?, scored = 1, updated_at = ? WHERE record_id = ?')
      .run(a, b, nowIso(), recordId)
    return { record_id: recordId, alpha: a, beta: b, scored: true }
  }

  // ---------- 审核（隔离区/待审区的出口） ----------

  /**
   * 审核并给出决定。没有出口的隔离区会变成垃圾场（方案自评里点过这条）。
   * approve / release → active；reject → rejected（保留正文，不物理删除）。
   */
  review(recordId, decision, note = null) {
    if (!REVIEW_DECISIONS.includes(decision)) throw new Error(`review: decision 只能是 ${REVIEW_DECISIONS.join(' / ')}`)
    const row = this.db.prepare('SELECT record_id, status FROM records WHERE record_id = ?').get(recordId)
    if (!row) throw new Error(`review: 没有记录 ${recordId}`)
    const status = decision === 'reject' ? 'rejected' : 'active'
    const now = nowIso()
    // 闸门裁决即确认（P1 公理 2）：approve / release 把来源信任升为 trusted，
    // reject 保持原信任等级但状态转 rejected（保留正文，不物理删除）。
    if (decision === 'reject') {
      this.db
        .prepare('UPDATE records SET status = ?, pending_review = 0, updated_at = ? WHERE record_id = ?')
        .run(status, now, recordId)
    } else {
      this.db
        .prepare("UPDATE records SET status = ?, pending_review = 0, trust_level = 'trusted', updated_at = ? WHERE record_id = ?")
        .run(status, now, recordId)
    }
    this.db
      .prepare(
        `INSERT INTO review_queue(record_id, reason, created_at, decided_at, decision, note)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(record_id) DO UPDATE SET decided_at = excluded.decided_at,
           decision = excluded.decision, note = excluded.note`,
      )
      .run(recordId, 'manual-review', now, now, decision, note)
    return { record_id: recordId, status, decision }
  }

  // ---------- 场景交接（源自 luanyujia-workbench 的记忆机制） ----------

  /**
   * 覆盖写一个场景的「§〇 交接」。
   * 规则（与 workbench 一致）：
   *  - 只留最新一份，覆盖不追加；
   *  - ≤ 4 KB，超了说明在写过程而不是写结论；
   *  - 五小节固定键：last / projects / changes / next / blockers。
   */
  handoffWrite({ scene, title = null, sections, updatedBy = null } = {}) {
    const key = String(scene ?? '').trim()
    if (!key) throw new Error('handoffWrite: scene 不能为空')
    const allow = ['last', 'projects', 'changes', 'next', 'blockers']
    const clean = {}
    for (const k of allow) {
      const v = sections?.[k]
      if (v !== undefined && v !== null && String(v).trim() !== '') clean[k] = String(v)
    }
    if (Object.keys(clean).length === 0) throw new Error('handoffWrite: 至少写一个小节')
    const json = JSON.stringify(clean)
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > 4096) {
      throw new Error(`handoffWrite: 交接 ${bytes} 字节，超过 4096 上限（只留结论与指针，历史搬归档）`)
    }
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO handoffs (scene, title, sections, bytes, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scene) DO UPDATE SET
           title = excluded.title, sections = excluded.sections, bytes = excluded.bytes,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(key, title, json, bytes, now, updatedBy)
    this._trace({ op: 'handoff', scene: key, bytes })
    return { scene: key, bytes, updated_at: now, sections: clean }
  }

  handoffRead(scene) {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE scene = ?').get(String(scene ?? ''))
    if (!row) return null
    return { ...row, sections: JSON.parse(row.sections) }
  }

  handoffList() {
    return this.db
      .prepare('SELECT scene, title, bytes, updated_at, updated_by FROM handoffs ORDER BY updated_at DESC')
      .all()
  }

  /**
   * 体量体检：把 workbench 的红线落到库上。
   * 交接 ≤4 KB；场景记忆（该项目下记录正文总和）≤25 KB；待审 ≤20；审计链一致。
   */
  checkBudgets(scene = null) {
    const items = []
    const handoffs = scene
      ? this.db.prepare('SELECT scene, bytes FROM handoffs WHERE scene = ?').all(String(scene))
      : this.db.prepare('SELECT scene, bytes FROM handoffs').all()
    for (const h of handoffs) {
      items.push({ name: '交接 ' + h.scene, value: h.bytes, limit: 4096, ok: h.bytes <= 4096 })
    }
    if (scene) {
      const size = this.db
        .prepare('SELECT COALESCE(SUM(length(content)), 0) n FROM records WHERE project_id = ?')
        .get(String(scene)).n
      items.push({ name: '场景记忆 ' + scene, value: size, limit: 25600, ok: size <= 25600 })
    }
    const pending = this.db.prepare('SELECT COUNT(*) n FROM review_queue WHERE decision IS NULL').get().n
    items.push({ name: '待审积压', value: pending, limit: 20, ok: pending <= 20 })
    const chainOk = this.auditHealth?.ok !== false
    items.push({ name: '审计链', value: chainOk ? 1 : 0, limit: 1, ok: chainOk })
    return { ok: items.every((i) => i.ok), items }
  }

  // ---------- 派单台账（协作/派单机制） ----------

  /**
   * 建一条派单或公告。
   *  - dispatch：要对方动手，四件套（现象/照哪做/怎么验/回一句）缺一不可；
   *  - notice：只落盘知悉，不要求四件套。
   */
  dispatchCreate({ kind = 'dispatch', from, to, title, phenomenon, howTo, howVerify, needReply = true, deadlineMinutes = 1440 } = {}) {
    const k = kind === 'notice' ? 'notice' : 'dispatch'
    const f = String(from ?? '').trim()
    const t = String(to ?? '').trim()
    const ti = String(title ?? '').trim()
    if (!f || !t) throw new Error('dispatchCreate: from / to 都不能为空')
    if (!ti) throw new Error('dispatchCreate: title 不能为空')
    if (k === 'dispatch') {
      const missing = []
      if (!String(phenomenon ?? '').trim()) missing.push('现象')
      if (!String(howTo ?? '').trim()) missing.push('照哪做')
      if (!String(howVerify ?? '').trim()) missing.push('怎么验')
      if (missing.length) throw new Error(`dispatchCreate: 派单四件套缺 ${missing.join(' / ')}（缺一件对方就得追问）`)
    }
    const now = nowIso()
    const id = ulid()
    const mins = k === 'dispatch' ? Math.max(1, Number(deadlineMinutes) || 1440) : null
    const deadline = k === 'dispatch' ? new Date(Date.now() + mins * 60000).toISOString() : null
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, kind, from_scene, to_scene, title, phenomenon, how_to, how_verify,
           need_reply, status, messages, created_at, updated_at, deadline_at, ack_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 1, ?, ?, ?, NULL)`,
      )
      .run(id, k, f, t, ti, phenomenon ?? null, howTo ?? null, howVerify ?? null, needReply ? 1 : 0, now, now, deadline)
    this._trace({ op: k === 'dispatch' ? 'dispatch' : 'notice', task_id: id, from: f, to: t })
    return this.taskGet(id)
  }

  /**
   * 回执：接单方干完 / 卡住 / 干不了都要回，且必须带证据。
   * 同一件事 ≤3 条消息（派单 + 回执 + 收尾知悉）。
   */
  taskReceipt({ taskId, conclusion, evidence, path, remaining } = {}) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(String(taskId ?? ''))
    if (!row) throw new Error('taskReceipt: 没有这条任务 ' + String(taskId))
    if (row.messages >= 3) throw new Error('taskReceipt: 同一件事已 3 条消息（派单+回执+知悉），到上限了')
    if (!String(conclusion ?? '').trim()) throw new Error('taskReceipt: 回执必须写结论')
    if (!String(evidence ?? '').trim()) throw new Error('taskReceipt: 回执必须带证据（跑了什么 / 几条通过），只说"好了"等于没说')
    const ack = {
      conclusion: String(conclusion),
      evidence: String(evidence),
      path: path ? String(path) : null,
      remaining: remaining ? String(remaining) : null,
    }
    const now = nowIso()
    this.db
      .prepare("UPDATE tasks SET status = 'acked', messages = messages + 1, ack_json = ?, updated_at = ? WHERE task_id = ?")
      .run(JSON.stringify(ack), now, row.task_id)
    this._trace({ op: 'receipt', task_id: row.task_id, to: row.from_scene })
    return this.taskGet(row.task_id)
  }

  /** 状态推进：delivered / done / failed / closed。 */
  taskMark({ taskId, status, actor = null } = {}) {
    const allow = ['delivered', 'done', 'failed', 'closed']
    if (!allow.includes(status)) throw new Error('taskMark: status 只能是 ' + allow.join(' / '))
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(String(taskId ?? ''))
    if (!row) throw new Error('taskMark: 没有这条任务 ' + String(taskId))
    if (status === 'delivered' && row.status !== 'sent') throw new Error('taskMark: 只有 sent 可以标记为 delivered')
    if (status === 'done' && row.status !== 'acked') throw new Error('taskMark: 只有 acked 可以销账为 done')
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
      .run(status, nowIso(), row.task_id)
    this._trace({ op: 'task.' + status, task_id: row.task_id, actor })
    return this.taskGet(row.task_id)
  }

  taskGet(taskId) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(String(taskId ?? ''))
    if (!row) return null
    return { ...row, ack: row.ack_json ? JSON.parse(row.ack_json) : null }
  }

  /**
   * 台账查询。scope：
   *  - outbound：我发出、还没回的（催对方）
   *  - inbound：别人发给我、我还没回的（我欠别人）
   *  - open：全部未办结
   */
  taskList({ scene = null, scope = 'open' } = {}) {
    const now = Date.now()
    let rows = []
    if (scope === 'outbound') {
      rows = this.db.prepare("SELECT * FROM tasks WHERE from_scene = ? AND status IN ('sent','delivered','overdue')").all(String(scene))
    } else if (scope === 'inbound') {
      rows = this.db.prepare("SELECT * FROM tasks WHERE to_scene = ? AND status IN ('sent','delivered','overdue')").all(String(scene))
    } else if (scope === 'all') {
      rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200').all()
    } else {
      rows = this.db.prepare("SELECT * FROM tasks WHERE status NOT IN ('done','closed','failed') ORDER BY created_at DESC LIMIT 200").all()
    }
    return rows.map((r) => {
      const overdue = (r.status === 'sent' || r.status === 'delivered') && r.deadline_at && Date.parse(r.deadline_at) < now
      return { ...r, ack: r.ack_json ? JSON.parse(r.ack_json) : null, overdue, effective_status: overdue ? 'overdue' : r.status }
    })
  }

  taskOverdueCount(scene = null) {
    return this.taskList({ scene, scope: scene ? 'outbound' : 'all' }).filter((t) => t.overdue).length
  }

  // ---------- 检索 ----------

  /**
   * 检索。默认只返回 active 且非 S 级；S 级需显式 includeSensitive。
   * 每条结果带信任级、评分状态与使用约束（方案 §18/§19）。
   */
  search(input) {
    const t0 = Date.now()
    const hits = this._searchInternal(input)
    this._trace({
      op: 'search',
      query: input?.query ?? '',
      hits: hits.map((h) => h.record_id),
      tokens_in: Math.ceil(String(input?.query ?? '').length / 3),
      tokens_out: Math.ceil(hits.reduce((sum, h) => sum + String(h.snippet ?? '').length, 0) / 3),
      duration_ms: Date.now() - t0,
      principal_id: input?.principalId ?? null,
    })
    return hits
  }

  /**
   * 联想：从一条记忆或一句话出发，找标签、语义、情绪上相近的记忆。
   * 认知层的第二块——不是“搜索”，是“由 A 想到 B”。
   */
  buildEdges({ limit = 5000 } = {}) {
    const now = nowIso()
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM edges')
      this.db
        .prepare(
          `INSERT OR IGNORE INTO edges(from_id, to_id, kind, weight, created_at)
           SELECT a.record_id, b.record_id, 'tag', 1, ?
             FROM tags a JOIN tags b ON a.tag = b.tag AND a.record_id < b.record_id
            WHERE (SELECT status FROM records r WHERE r.record_id = a.record_id) = 'active'
              AND (SELECT status FROM records r WHERE r.record_id = b.record_id) = 'active'
            LIMIT ?`,
        )
        .run(now, limit)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO edges(from_id, to_id, kind, weight, created_at)
           SELECT a.record_id, b.record_id, 'batch', 1, ?
             FROM records a JOIN records b
               ON a.batch_id = b.batch_id AND a.batch_id IS NOT NULL AND a.record_id < b.record_id
            WHERE a.status = 'active' AND b.status = 'active'
            LIMIT ?`,
        )
        .run(now, limit)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.db.prepare('SELECT COUNT(*) AS n FROM edges').get().n
  }

  graphNeighbors(recordId, { hops = 1, edgeTypes = null } = {}) {
    const maxHops = Math.min(Math.max(Number(hops) || 1, 1), 3)
    const kinds = Array.isArray(edgeTypes) && edgeTypes.length > 0 ? edgeTypes.map(String) : null
    const nodes = new Map()
    const edges = []
    const root = String(recordId)
    let frontier = [root]
    nodes.set(root, 0)
    for (let h = 0; h < maxHops; h += 1) {
      const next = []
      for (const id of frontier) {
        const rows = this.db.prepare('SELECT from_id AS a, to_id AS b, kind, weight FROM edges WHERE from_id = ? OR to_id = ?').all(id, id)
        for (const row of rows) {
          if (kinds && !kinds.includes(row.kind)) continue
          const other = row.a === id ? row.b : row.a
          edges.push({ from: row.a, to: row.b, kind: row.kind, weight: row.weight })
          if (!nodes.has(other)) {
            nodes.set(other, h + 1)
            next.push(other)
          }
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    const ids = [...nodes.keys()]
    const detail = ids.length
      ? this.db
          .prepare(`SELECT record_id, layer, sad_level, summary FROM records WHERE record_id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids)
      : []
    const byId = new Map(detail.map((r) => [r.record_id, r]))
    return {
      root,
      nodes: ids.map((id) => ({ record_id: id, depth: nodes.get(id), ...(byId.get(id) ?? {}) })),
      edges,
    }
  }

  graphTraverse(seedIds, { hops = 2, edgeTypes = null } = {}) {
    const seeds = (Array.isArray(seedIds) ? seedIds : [seedIds]).filter(Boolean).map(String)
    const nodes = new Map()
    const edges = []
    for (const seed of seeds) {
      const result = this.graphNeighbors(seed, { hops, edgeTypes })
      for (const node of result.nodes) if (!nodes.has(node.record_id)) nodes.set(node.record_id, node)
      edges.push(...result.edges)
    }
    const seen = new Set()
    const unique = edges.filter((e) => {
      const key = e.from + '|' + e.to + '|' + e.kind
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { seeds, nodes: [...nodes.values()], edges: unique }
  }

  associate(input = {}) {
    const limit = Math.min(Math.max(Number(input.topK ?? 5), 1), 20)
    const seed = input.recordId
      ? this.db
          .prepare(
            'SELECT record_id, summary, content, layer, affect_label, affect_valence, affect_arousal, importance FROM records WHERE record_id = ?',
          )
          .get(String(input.recordId))
      : null
    const found = new Map()
    const addHit = (row, reason, weight) => {
      if (!row?.record_id) return
      const current = found.get(row.record_id)
      if (current) {
        current.weight += weight
        if (!current.reasons.includes(reason)) current.reasons.push(reason)
        return
      }
      found.set(row.record_id, {
        record_id: row.record_id,
        summary: row.summary ?? '',
        layer: row.layer ?? '',
        affect_label: row.affect_label ?? null,
        importance: row.importance ?? null,
        weight,
        reasons: [reason],
      })
    }

    if (seed) {
      const tags = this.db.prepare('SELECT tag FROM tags WHERE record_id = ?').all(seed.record_id).map((r) => r.tag)
      for (const tag of tags) {
        const rows = this.db
          .prepare(
            `SELECT r.record_id, r.summary, r.layer, r.affect_label, r.importance
               FROM records r JOIN tags t ON t.record_id = r.record_id
              WHERE t.tag = ? AND r.record_id <> ? AND r.status = 'active' AND r.sad_level != 'S'
              ORDER BY r.importance DESC LIMIT ?`,
          )
          .all(tag, seed.record_id, limit)
        for (const row of rows) addHit(row, `标签:${tag}`, 1)
      }
      if (seed.affect_label && seed.affect_label !== 'neutral') {
        const rows = this.db
          .prepare(
            `SELECT record_id, summary, layer, affect_label, importance FROM records
              WHERE affect_label = ? AND record_id <> ? AND status = 'active' AND sad_level != 'S'
              ORDER BY importance DESC LIMIT ?`,
          )
          .all(seed.affect_label, seed.record_id, limit)
        for (const row of rows) addHit(row, `同情绪:${seed.affect_label}`, 0.4)
      }
    }

    const text = String(input.query ?? seed?.summary ?? '').trim()
    if (text) {
      let hits = []
      try {
        hits = this._searchInternal({ query: text, topK: limit, includeSensitive: input.includeSensitive === true })
      } catch {
        hits = []
      }
      for (const row of hits) {
        if (seed && row.record_id === seed.record_id) continue
        addHit(row, '语义', 0.8)
      }
    }

    const items = [...found.values()]
      .sort((a, b) => b.weight - a.weight || (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, limit)
      .map((item) => ({ ...item, weight: Math.round(item.weight * 10) / 10 }))

    return {
      seed: seed
        ? {
            record_id: seed.record_id,
            summary: seed.summary,
            layer: seed.layer,
            affect_label: seed.affect_label,
          }
        : null,
      items,
    }
  }

  _searchInternal(input) {
    const query = String(input.query ?? '').trim()
    const topK = Math.min(Math.max(Number(input.topK ?? 10), 1), 50)
    if (!query) return []
    const match = toMatchQuery(query)
    if (!match) return []

    const where = ['records_fts MATCH ?', "r.status = 'active'"]
    const params = [match]
    if (LAYERS.includes(input.layer)) {
      where.push('r.layer = ?')
      params.push(input.layer)
    }
    if (!input.includeSensitive) where.push("r.sad_level != 'S'")
    params.push(topK)

    const rows = this.db
      .prepare(
        `SELECT r.record_id, r.layer, r.summary, r.sad_level, r.trust_level, r.source_channel,
                r.project_id, r.created_at, r.content_hash, r.alpha, r.beta, r.scored,
                bm25(records_fts) AS score
           FROM records_fts
           JOIN records r ON r.record_id = records_fts.record_id
          WHERE ${where.join(' AND ')}
          ORDER BY score ASC
          LIMIT ?`,
      )
      .all(...params)

    return rows.map((row) => {
      const caveat = usageCaveat({ trustLevel: row.trust_level, beta: row.beta, scored: row.scored })
      return {
        record_id: row.record_id,
        layer: row.layer,
        snippet: row.summary,
        score: row.score,
        content_hash: row.content_hash,
        source_channel: row.source_channel,
        trust_level: row.trust_level,
        sad_level: row.sad_level,
        project_id: row.project_id,
        created_at: row.created_at,
        alpha: row.alpha,
        beta: row.beta,
        scored: row.scored === 1,
        caveat,
      }
    })
  }

  /** 读全文。S 级需要 includeSensitive 才给正文（一期先这么收紧，二期接权限判定）。 */
  read(recordId, options = {}) {
    const row = this.db.prepare('SELECT * FROM records WHERE record_id = ?').get(recordId)
    this._trace({
      op: 'read',
      record_id: String(recordId ?? ''),
      denied: Boolean(row && row.sad_level === 'S' && !options.includeSensitive),
      sad_level: row?.sad_level ?? null,
      layer: row?.layer ?? null,
      principal_id: options.principalId ?? null,
    })
    if (!row) return null
    if (isEncrypted(row.content)) {
      try {
        row.content = decryptText(row.content, loadKey(this.dataDir))
      } catch (error) {
        return { ...row, content: '', denied: true, reason: '已加密但无法解密：' + (error?.message ?? String(error)) }
      }
    }
    if (row.sad_level === 'S' && !options.includeSensitive) {
      // 注意：不能把 content 置成 undefined —— 宿主要求返回值是 lossless JSON，
      // 含 undefined 的键会直接报 "value is not lossless JSON"，所以整个键都不出现。
      const { content: _withheld, ...meta } = row
      return { ...meta, denied: true, reason: 'S 级记录需要显式授权（include_sensitive=true）' }
    }
    return row
  }

  // ---------- 四期：加密 ----------

  cryptoStatus() {
    return cryptoInfo(this.dataDir)
  }

  enableCrypto() {
    const { created } = ensureKey(this.dataDir)
    this._trace({ op: 'crypto.enable' })
    return { created, ...cryptoInfo(this.dataDir) }
  }

  encryptRecord(recordId) {
    const key = loadKey(this.dataDir)
    if (!key) throw new Error('尚未启用加密：先执行 enable')
    const row = this.db.prepare('SELECT content FROM records WHERE record_id = ?').get(String(recordId))
    if (!row) throw new Error('记录不存在')
    const next = encryptText(row.content, key)
    this.db.prepare('UPDATE records SET content = ? WHERE record_id = ?').run(next, String(recordId))
    this._trace({ op: 'crypto.encrypt', record_id: String(recordId) })
    return { record_id: String(recordId), encrypted: true }
  }

  decryptRecord(recordId) {
    const row = this.db.prepare('SELECT content FROM records WHERE record_id = ?').get(String(recordId))
    if (!row) throw new Error('记录不存在')
    if (!isEncrypted(row.content)) return { record_id: String(recordId), encrypted: false }
    const plain = decryptText(row.content, loadKey(this.dataDir))
    this.db.prepare('UPDATE records SET content = ? WHERE record_id = ?').run(plain, String(recordId))
    this._trace({ op: 'crypto.decrypt', record_id: String(recordId) })
    return { record_id: String(recordId), encrypted: false }
  }

  // ---------- 二期：导入 / 影子读 / 回放 ----------

  /**
   * 导入旧记忆（只读 + 脱敏 + 幂等）。
   * @param {{dryRun?: boolean, home?: string}} [options]
   */
  importLegacy(options = {}) {
    if (this.getAuthority() === 'legacy') {
      // legacy 模式下新库只写不读，导入仍然允许（它只是补数据）
    }
    const importer = new LegacyImporter({ store: this, home: options.home })
    const report = importer.run({ dryRun: options.dryRun === true })
    this._trace({
      op: 'import',
      imported: report.imported,
      skipped: report.skipped,
      redacted: report.redacted,
      errors: report.errors.length,
      dry_run: report.dry_run,
      principal_id: 'owner',
    })
    return report
  }

  /** 影子读：新旧两路并排。 */
  shadow({ query, topK = 5, home } = {}) {
    const index = new LegacyIndex({ home })
    const result = shadowCompare({ store: this, index, query, topK })
    this._trace({
      op: 'shadow',
      query: query ?? '',
      hits: result.mine.map((h) => h.record_id),
      only_legacy: result.diff.only_legacy.length,
      only_new: result.diff.only_new.length,
      consistent: result.consistent,
    })
    return result
  }

  /** 按 trace_id 回放（先查索引表，再回落到 JSONL）。 */
  traceLookup(traceId) {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(String(traceId ?? ''))
    const fromJsonl = this.recorder?.trace(traceId) ?? null
    if (!row && !fromJsonl) return null
    return {
      trace_id: row?.trace_id ?? fromJsonl.trace_id,
      seq: row?.seq ?? fromJsonl.seq,
      at: row?.at ?? fromJsonl.at,
      op: row?.op ?? fromJsonl.op,
      query_preview: row?.query_preview ?? fromJsonl.query_preview ?? null,
      query_hash: row?.query_hash ?? fromJsonl.query_hash ?? null,
      hits: row ? JSON.parse(row.hits || '[]') : (fromJsonl.hits ?? []),
      injected: row ? JSON.parse(row.injected || '[]') : (fromJsonl.injected ?? []),
      tokens_in: row?.tokens_in ?? fromJsonl.tokens_in ?? null,
      tokens_out: row?.tokens_out ?? fromJsonl.tokens_out ?? null,
      duration_ms: row?.duration_ms ?? fromJsonl.duration_ms ?? null,
      prev_hash: row?.prev_hash ?? fromJsonl.prev ?? null,
      hash: row?.hash ?? fromJsonl.hash ?? null,
      file: fromJsonl?.file ?? null,
    }
  }

  /** 审计体检：deep=true 时逐行重算整条链。 */
  audit({ deep = false } = {}) {
    const verify = this.recorder?.verify({ deep }) ?? { ok: null, lines: 0, files: 0, brokenAt: null }
    const stats = this.recorder?.stats() ?? { files: 0, bytes: 0, lastSeq: 0 }
    this.auditHealth = verify
    const recent = this.db.prepare('SELECT trace_id, at, op, hits FROM traces ORDER BY seq DESC LIMIT 5').all()
    return { ...verify, ...stats, recent, schema_version: this.getMeta('schema_version') }
  }

  // ---------- 统计 / 不变量 ----------

  stats() {
    const one = (sql) => this.db.prepare(sql).get()
    return {
      records: one('SELECT COUNT(*) AS n FROM records').n,
      fts: one('SELECT COUNT(*) AS n FROM records_fts').n,
      active: one("SELECT COUNT(*) AS n FROM records WHERE status = 'active'").n,
      pending: one("SELECT COUNT(*) AS n FROM records WHERE status = 'pending'").n,
      quarantined: one("SELECT COUNT(*) AS n FROM records WHERE status = 'quarantined'").n,
      rejected: one("SELECT COUNT(*) AS n FROM records WHERE status = 'rejected'").n,
      scored: one('SELECT COUNT(*) AS n FROM records WHERE scored = 1').n,
      sLevel: one("SELECT COUNT(*) AS n FROM records WHERE sad_level = 'S'").n,
      legacy: one("SELECT COUNT(*) AS n FROM records WHERE origin = 'legacy_import'").n,
      traces: one('SELECT COUNT(*) AS n FROM traces').n,
      audit: {
        ok: this.auditHealth?.ok ?? null,
        lines: this.auditHealth?.lines ?? 0,
        files: this.recorder?.stats?.().files ?? 0,
        bytes: this.recorder?.stats?.().bytes ?? 0,
        broken_at: this.auditHealth?.brokenAt ?? null,
      },
      byLayer: this.db.prepare('SELECT layer, COUNT(*) AS n FROM records GROUP BY layer ORDER BY layer').all(),
      authority: this.getAuthority(),
      dataDir: this.dataDir,
      schemaVersion: this.getMeta('schema_version'),
    }
  }

  /** 待审/隔离清单（review 的输入）。 */
  pendingReview(limit = 20) {
    return this.db
      .prepare(
        `SELECT r.record_id, r.layer, r.sad_level, r.trust_level, r.status, r.summary,
                r.conflict_of, r.created_at, q.reason
           FROM records r LEFT JOIN review_queue q ON q.record_id = r.record_id
          WHERE r.status IN ('pending','quarantined')
          ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(Number(limit) || 20, 1), 100))
  }

  /**
   * 运行时不变量检查（方案 §60）：索引与主表逐行一致，内容哈希与正文一致。
   */
  checkInvariants() {
    const records = this.db.prepare('SELECT record_id, content, content_hash FROM records').all()
    const ftsRows = this.db.prepare('SELECT record_id FROM records_fts').all()
    const ftsSet = new Set(ftsRows.map((r) => r.record_id))
    const recSet = new Set(records.map((r) => r.record_id))
    const missingFts = []
    const hashMismatch = []
    for (const row of records) {
      if (!ftsSet.has(row.record_id)) missingFts.push(row.record_id)
      if (sha256(row.content) !== row.content_hash) hashMismatch.push(row.record_id)
    }
    const orphanFts = [...ftsSet].filter((id) => !recSet.has(id))
    return {
      ok: missingFts.length === 0 && hashMismatch.length === 0 && orphanFts.length === 0,
      records: records.length,
      fts: ftsRows.length,
      missingFts,
      hashMismatch,
      orphanFts,
    }
  }

  // ---------- 快照（只读复制，不动原库） ----------

  maybeSnapshot(force = false) {
    const last = this.getMeta('last_snapshot_at')
    if (!force && last) {
      const ago = Date.now() - Date.parse(last)
      if (Number.isFinite(ago) && ago < this.snapshotIntervalMs) return null
    }
    return this.snapshot()
  }

  snapshot() {
    const stamp = new Date()
      .toLocaleString('sv-SE', { hour12: false })
      .replace(/[-: ]/g, '')
      .slice(0, 13)
    const dir = path.join(this.backupDir, `snap-${stamp}`)
    ensureDir(dir)
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* 快照失败不阻断主流程 */
    }
    fs.copyFileSync(this.dbFile, path.join(dir, 'memory.db'))
    const manifest = []
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      if (fs.statSync(file).isFile()) {
        manifest.push({ file: name, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) })
      }
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ created_at: nowIso(), files: manifest }, null, 2))
    this.setMeta('last_snapshot_at', nowUtc())
    return { dir, files: manifest }
  }
}

export default MemoryStore
