/**
 * tools.js — 工具定义（手写 JSON Schema，不 import 任何 @deepseek-ai 包）。
 *
 * 为什么手写：这个插件以 file:// 方式加载，目录里没有 node_modules，
 * 运行期解析不到 @deepseek-ai/dsh-tools。registry 只要求
 * { name, description, parameters(JSON Schema), output:{schema,render}, execute }，
 * 所以手写形状与 defineTool 的产物等价，同时把依赖降到零。
 */
import { canWrite } from './policy.js'
import { explainRecord } from './explain.js'
import { listParts, compose } from '../parts/index.js'
import { ingestQqSessions, affectReport } from './affect-events.js'
import { ledgerInit, ledgerSync, ledgerVerify, healthLine } from './ledger.js'
import { saveAffectReport } from './affect-report.js'

const textOut = (extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' }, ...extra },
  required: ['text'],
})

const renderText = (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }]

/** 所有工具的注册表：name → { label, argsHint, needsOpen, build(store, host) } */
export function buildRegistry(store, host) {
  /** @type {Map<string, {label:string, argsHint:string, needsOpen:boolean, definition:object}>} */
  const registry = new Map()

  const add = (definition, meta) => {
    registry.set(definition.name, { ready: true, ...meta, definition })
  }

  // ---------- 常驻：能力目录 ----------

  add(
    {
      name: 'mem_admin_catalog',
      description:
        '六层记忆底座的能力目录。返回：四个服务（storage/search/graph/crypto）的可用状态、可注入工具清单（含一行描述与调用签名）、' +
        '当前已注入的工具、权威源开关（legacy/shadow/new）与库统计。默认只常驻这一个工具，其他工具用 mem_admin_open 按需注入。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          include_signatures: { type: 'boolean', description: '是否返回每个工具的参数签名（默认 true）' },
        },
      },
      output: {
        schema: textOut({
          authority: { type: 'string' },
          services: { type: 'object', additionalProperties: true },
          tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
          injected: { type: 'array', items: { type: 'string' } },
          stats: { type: 'object', additionalProperties: true },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const withSignatures = args?.include_signatures !== false
        const stats = store.stats()
        const injected = host.injected()
        const services = {
          storage: { ready: true, required: true, detail: 'node:sqlite 内置，schema v3' },
          search: { ready: true, optional: true, detail: 'FTS5 + bigram 分词；向量路在三期' },
          audit: { ready: stats.audit?.ok !== false, required: true, detail: `JSONL 哈希链 ${stats.audit?.lines ?? 0} 行` },
          graph: { ready: true, optional: true, detail: '标签/同批次共现图，BFS 查询（v9）' },
          crypto: { ready: true, optional: true, detail: 'AES-256-GCM 静态加密（默认关，mem_crypto 开）' },
        }
        const tools = [...registry.entries()].map(([name, item]) => {
          const row = {
            name,
            label: item.label,
            injected: injected.includes(name),
            ready: item.ready !== false,
          }
          if (withSignatures) row.signature = item.argsHint
          return row
        })

        const lines = [
          `权威源开关 authority = ${stats.authority}（legacy=只走旧源 / shadow=新旧并读 / new=新库为准）`,
          `库：${stats.records} 条记录（active ${stats.active}，quarantined ${stats.quarantined}，S 级 ${stats.sLevel}），FTS ${stats.fts} 行，schema v${stats.schemaVersion}`,
          `数据目录：${stats.dataDir}`,
          `记录仪：${stats.audit?.ok === false ? '⚠ 断链' : '链一致'} / ${stats.audit?.lines ?? 0} 行 / ${stats.audit?.files ?? 0} 个文件`,
          `导入：legacy_import ${stats.legacy ?? 0} 条    traces ${stats.traces ?? 0} 条`,
          '服务：' + Object.entries(services).map(([k, v]) => `${k}=${v.ready ? 'ready' : 'degraded'}`).join('  '),
          `已注入：${injected.length ? injected.join(', ') : '（无，只有本目录）'}`,
          '可注入工具：',
          ...tools.map((t) => `  - ${t.name}（${t.label}）${t.injected ? ' [已注入]' : ''}${t.signature ? `\n      ${t.signature}` : ''}`),
          '用法：mem_admin_open({ tools: ["mem_search","mem_read"] }) 注入；mem_admin_call({ tool, arguments }) 单次调用。',
        ]

        return { text: lines.join('\n'), authority: stats.authority, services, tools, injected, stats }
      },
    },
    { label: '能力目录', argsHint: 'mem_admin_catalog({ include_signatures?: boolean })', needsOpen: false },
  )

  // ---------- 常驻：按需注入 ----------

  add(
    {
      name: 'mem_admin_open',
      description:
        '把指定工具注册进当前会话（按需注入）。空列表或缺失列表会被拒绝 —— 不默认全开。' +
        '已注入的工具在会话结束或插件卸载时自动清理。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tools: { type: 'array', items: { type: 'string' }, description: '要注入的工具名列表，至少一个' },
        },
        required: ['tools'],
      },
      output: { schema: textOut({ injected: { type: 'array', items: { type: 'string' } } }), render: renderText },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const names = Array.isArray(args?.tools) ? args.tools.filter((n) => typeof n === 'string' && n.trim()) : []
        if (names.length === 0) throw new Error('mem_admin_open: tools 不能为空（不默认全开）')
        const unknown = names.filter((n) => !registry.has(n))
        if (unknown.length) throw new Error(`mem_admin_open: 未知工具 ${unknown.join(', ')}`)
        const skip = names.filter((n) => n === 'mem_admin_catalog')
        const injected = host.open(names.filter((n) => n !== 'mem_admin_catalog'))
        const lines = [`已注入 ${injected.length} 个工具：${injected.join(', ') || '（无）'}`]
        if (skip.length) lines.push('提示：mem_admin_catalog 常驻，无需注入。')
        return { text: lines.join('\n'), injected }
      },
    },
    { label: '按需注入', argsHint: 'mem_admin_open({ tools: string[] })', needsOpen: false },
  )

  add(
    {
      name: 'mem_admin_call',
      description: '单次直接调用一个工具，不把它注册为常驻工具。用于一次性操作。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string', description: '工具名，例如 mem_search' },
          arguments: { type: 'object', additionalProperties: true, description: '该工具的参数对象' },
        },
        required: ['tool'],
      },
      output: { schema: textOut({ tool: { type: 'string' }, result: { type: 'object', additionalProperties: true } }), render: renderText },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const name = String(args?.tool ?? '').trim()
        const item = registry.get(name)
        if (!item) throw new Error(`mem_admin_call: 未知工具 ${name}`)
        const value = await item.definition.execute(args?.arguments ?? {})
        return { text: String(value?.text ?? ''), tool: name, result: value ?? {} }
      },
    },
    { label: '单次调用', argsHint: 'mem_admin_call({ tool: string, arguments?: object })', needsOpen: false },
  )

  // ---------- 可注入：写入 ----------

  add(
    {
      name: 'mem_write',
      description:
        '写入一条记忆。走完整写入链：通道×身份信任判定 → 投毒/凭证扫描 → 沉淀前决策（低价值不落库）→ S/A 分级 → 内容去重 → 冲突与疑似矛盾标记 → 落库。' +
        '凭证类判 S 级（不进自动召回）；命中投毒特征进隔离区；与既有记录疑似矛盾则进待审区。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: '正文（必填，≤200k 字符）' },
          layer: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'], description: '层，默认 L2' },
          summary: { type: 'string', description: '一行摘要；缺省取正文前 120 字' },
          source_channel: { type: 'string', description: '来源通道：user / host / tool / web / mcp / import / legacy_import' },
          identity_id: { type: 'string', description: '调用方身份：owner / agent / unknown（缺省 agent）' },
          trust_level: { type: 'string', enum: ['trusted', 'unverified', 'tainted'], description: '覆盖默认信任级（默认由通道×身份决定）' },
          sad_level: { type: 'string', enum: ['S', 'A', 'D'], description: '覆盖默认分级（默认凭证→S，其余 A）' },
          principal_id: { type: 'string' },
          project_id: { type: 'string' },
          session_id: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content'],
      },
      output: {
        schema: textOut({
          record_id: { type: 'string' },
          dedup: { type: 'boolean' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
          layer: { type: 'string' },
          sad_level: { type: 'string' },
          trust_level: { type: 'string' },
          status: { type: 'string' },
          conflict: { type: 'boolean' },
          conflict_of: { type: 'string' },
          contradiction: { type: 'boolean' },
          scanned: { type: 'array', items: { type: 'string' } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const r = store.write({
          content: args?.content,
          layer: args?.layer,
          summary: args?.summary,
          sourceChannel: args?.source_channel,
          identityId: args?.identity_id,
          trustLevel: args?.trust_level,
          sadLevel: args?.sad_level,
          principalId: args?.principal_id,
          projectId: args?.project_id,
          sessionId: args?.session_id,
          tags: args?.tags,
          origin: 'manual',
          explicit: true,
        })

        const lines = []
        if (r.skipped) {
          lines.push(`未落库（沉淀前决策）：${r.reason}`)
        } else if (r.dedup) {
          lines.push(`已存在相同内容，未重复写入：${r.record_id}`)
        } else {
          lines.push(`已写入 ${r.record_id}`)
        }
        lines.push(`层 ${r.layer} / 分级 ${r.sad_level} / 信任 ${r.trust_level} / 状态 ${r.status}`)
        lines.push(r.scanned?.length ? `扫描命中：${r.scanned.join(', ')}` : '扫描无命中')
        if (r.conflict) lines.push(`与既有记录主题重叠：${r.conflict_of}（已并存，未覆盖）`)
        if (r.contradiction) lines.push('疑似与既有记录结论相反：已进待审区，需 mem_review 审核后才参与召回')

        return {
          text: lines.join('\n'),
          record_id: r.record_id ?? '',
          dedup: r.dedup,
          skipped: r.skipped,
          reason: r.reason ?? '',
          layer: r.layer,
          sad_level: r.sad_level,
          trust_level: r.trust_level,
          status: r.status,
          conflict: r.conflict,
          conflict_of: r.conflict_of ?? '',
          contradiction: r.contradiction,
          scanned: r.scanned ?? [],
        }
      },
    },
    { label: '写入记忆', argsHint: 'mem_write({ content, layer?, identity_id?, source_channel?, ... })', needsOpen: true },
  )

  // ---------- 可注入：检索 ----------

  add(
    {
      name: 'mem_search',
      description:
        '三路混合检索的一期版本：BM25（FTS5 + 中文 bigram 分词）。无命中返回空数组，不注入任何说明性文字。' +
        '默认只返回 active 且非 S 级的记录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索词（中文按二字组切分）' },
          layer: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] },
          top_k: { type: 'integer', description: '返回条数，默认 10，上限 50' },
          include_sensitive: { type: 'boolean', description: '是否包含 S 级记录（默认 false）' },
        },
        required: ['query'],
      },
      output: {
        schema: textOut({
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'integer' },
        }),
        render: (args, value) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const hits = store.search({
          query: args?.query,
          layer: args?.layer,
          topK: args?.top_k,
          includeSensitive: args?.include_sensitive === true,
        })
        // 给每条挂上"人话"：模型读着顺手，用户看到的卡片也不用再解 record_id
        const decorated = hits.map((h) => {
          try {
            return { ...h, display: explainRecord(h) }
          } catch {
            return h
          }
        })
        const text = decorated.length === 0
          ? ''
          : decorated
              .map((h, i) => {
                const mark = h.scored ? '' : '·未评分'
                const caveat = h.caveat ? `  ⚠ ${h.caveat}` : ''
                const d = h.display || {}
                const head = d.title ? `【${d.kind}】${d.title}` : h.snippet
                const body = d.plain ? ` —— ${d.plain}` : ''
                return `${i + 1}. ${head}${body}  [${h.layer}/${h.sad_level} · ${h.trust_level}${mark} · 来源 ${h.source_channel} · score ${h.score.toFixed(2)}]${caveat}`
              })
              .join('\n')
        return { text, hits: decorated, count: decorated.length }
      },
    },
    { label: '检索', argsHint: 'mem_search({ query, layer?, top_k?, include_sensitive? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_affect_report',
      description: '情绪报告：区间内的情绪分布、负面占比、高频触发词、时段分布（目前数据源只采 QQ）。',
      parameters: { type: 'object', additionalProperties: false, properties: { range: { type: 'string', enum: ['day', 'week', 'month'] }, save: { type: 'boolean', description: '是否落盘成 Markdown 报告' } } },
      output: { schema: textOut({ report: { type: 'object', additionalProperties: true } }), render: renderText },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const range = args?.range ?? 'day'
        if (args?.save) {
          const saved = saveAffectReport({ store, dataDir: store.dataDir ?? 'D:/001/CH002/dsh-memory-data', range })
          return { text: '已生成报告：' + saved.path + '\n\n' + saved.text, report: saved.report }
        }
        const report = affectReport({ store, range })
        const labels = report.byLabel
        const lines = [
          '区间：' + report.range + '（自 ' + report.since.slice(0, 10) + '）',
          '事件 ' + report.total + ' 条：中性 ' + (labels.neutral || 0) + ' · 正面 ' + (labels.positive || 0) + ' · 负面 ' + (labels.negative || 0) + ' · 紧急 ' + (labels.urgent || 0),
          '负面占比 ' + Math.round(report.negativeRatio * 100) + '%',
        ]
        if (report.topTriggers.length) lines.push('高频触发：' + report.topTriggers.map((x) => x.word + '×' + x.n).join('、'))
        if (report.byHour.length) lines.push('时段：' + report.byHour.map((x) => x.hour + '时×' + x.n).join(' '))
        return { text: lines.join('\n'), report }
      },
    },
    { label: '情绪报告', argsHint: 'mem_affect_report({ range?: day|week|month })', needsOpen: true },
  )

  add(
    {
      name: 'mem_affect_ingest',
      description: '立即采集 QQ 会话里的用户消息，标注情绪写入情绪事件表（默认最近 20 个会话）。',
      parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' } } },
      output: { schema: textOut({ result: { type: 'object', additionalProperties: true } }), render: renderText },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const result = ingestQqSessions({ store, limit: args?.limit ?? 20 })
        return {
          text: '扫描会话 ' + result.files + ' 个，用户消息 ' + result.scanned + ' 条，新增 ' + result.added + ' 条，已存在 ' + result.skipped + ' 条',
          result,
        }
      },
    },
    { label: '情绪采集', argsHint: 'mem_affect_ingest({ limit? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_resume',
      description: '续跑：列出未完成任务 + 对应交接 + 相关记忆，一句话接上上次的工作。新会话或 QQ 里说「接着上次的干」时调它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', description: '限定场景（to_scene/from_scene 或交接头）' },
          limit: { type: 'integer', description: '任务条数，默认 5' },
        },
      },
      output: {
        schema: textOut({
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          handoff: { type: 'object', additionalProperties: true },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const scene = String(args?.scene ?? '').trim()
        const limit = Math.min(Math.max(Number(args?.limit ?? 5), 1), 20)
        const params = []
        let where = "status NOT IN ('done','closed','failed')"
        if (scene) {
          where += ' AND (to_scene = ? OR from_scene = ?)'
          params.push(scene, scene)
        }
        const rows = store.db
          .prepare(
            `SELECT task_id, kind, from_scene, to_scene, title, status, phenomenon, how_to, how_verify, created_at, deadline_at
               FROM tasks WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...params, limit)

        let handoff = null
        if (scene) {
          try {
            handoff = store.handoffRead(scene)
          } catch {
            handoff = null
          }
        }

        const lines = []
        if (handoff) {
          lines.push(`交接（${scene}）：${handoff.title ?? ''}`)
          const sections = handoff.sections
          if (Array.isArray(sections)) {
            for (const s of sections) lines.push(`- ${s.title ?? s.name ?? '段落'}：${String(s.body ?? s.content ?? '').slice(0, 200)}`)
          } else if (sections && typeof sections === 'object') {
            for (const [k, v] of Object.entries(sections)) lines.push(`- ${k}：${String(v).slice(0, 200)}`)
          }
          lines.push('')
        }

        if (!rows.length) {
          lines.push('没有未完成的任务。')
        } else {
          lines.push(`未完成任务 ${rows.length} 条：`)
          for (const r of rows) {
            lines.push(`- ${r.task_id} [${r.status}] ${r.title}（${r.from_scene} → ${r.to_scene}）`)
            if (r.phenomenon) lines.push(`    现象：${r.phenomenon}`)
            if (r.how_to) lines.push(`    做法：${r.how_to}`)
            if (r.how_verify) lines.push(`    验收：${r.how_verify}`)
          }
        }

        const related = []
        for (const r of rows.slice(0, 3)) {
          try {
            const hits = store.search({ query: r.title, topK: 2 })
            for (const h of hits) related.push(`- [${h.layer}] ${h.summary} ｜ 相关任务 ${r.task_id}`)
          } catch {
            /* 检索失败不影响续跑 */
          }
        }
        if (related.length) lines.push('', '相关记忆：', ...related)

        return { text: lines.join('\n'), tasks: rows, handoff: handoff ?? {} }
      },
    },
    { label: '续跑', argsHint: 'mem_resume({ scene?, limit? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_parts',
      description: '零件清单：列出记忆可装配的零件（名称/版本/用途）。记忆不是黑盒，是一组可替换的零件。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: textOut({ parts: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async () => {
        const parts = listParts()
        return {
          text: parts.map((p) => `- ${p.name} v${p.version}：${p.describe}`).join('\n'),
          parts,
        }
      },
    },
    { label: '零件清单', argsHint: 'mem_parts()', needsOpen: true },
  )

  add(
    {
      name: 'mem_compose',
      description: '按零件装配一段上下文：给定场景与零件列表，拼出可直接使用的记忆包（去重、限长、带来源标注）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', description: '场景名（scene 零件按 tag 匹配）' },
          parts: { type: 'array', items: { type: 'string' }, description: '零件名列表，默认 ["profile","lessons","recent"]' },
          seed: { type: 'string', description: 'associations 零件的种子（record_id 或文本）' },
          max_chars: { type: 'integer', description: '总长度上限，默认 1200' },
        },
      },
      output: {
        schema: textOut({
          text: { type: 'string' },
          parts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const result = compose(store, {
          scene: args?.scene,
          parts: args?.parts,
          seed: args?.seed,
          maxChars: args?.max_chars,
        })
        return { text: result.text || '（没有可装配的内容）', parts: result.parts }
      },
    },
    { label: '装配', argsHint: 'mem_compose({ scene?, parts?, seed?, max_chars? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_associate',
      description: '联想：给一条记忆 ID 或一句话，返回标签、语义、情绪上相近的其他记忆（带联想理由与权重）。用于「由 A 想到 B」。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_id: { type: 'string', description: '种子记录 ID（ULID）' },
          query: { type: 'string', description: '种子文本；没有 record_id 时用它' },
          top_k: { type: 'integer', description: '返回条数，默认 5，最多 20' },
        },
      },
      output: {
        schema: textOut({
          seed: { type: 'object', additionalProperties: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const result = store.associate({
          recordId: args?.record_id,
          query: args?.query,
          topK: args?.top_k,
        })
        const lines = []
        if (result.seed) {
          lines.push(
            `种子：${result.seed.record_id}（${result.seed.layer}${result.seed.affect_label ? ' / ' + result.seed.affect_label : ''}）${result.seed.summary}`,
          )
        } else if (args?.query) {
          lines.push(`种子：${args.query}`)
        }
        if (!result.items.length) lines.push('没有找到相关联的记忆。')
        for (const item of result.items) {
          lines.push(
            `- ${item.record_id} [${item.layer}${item.affect_label ? '/' + item.affect_label : ''}] ${item.summary} ｜ 理由：${item.reasons.join('、')} ｜ 权重 ${item.weight}`,
          )
        }
        return { text: lines.join('\n'), seed: result.seed ?? {}, items: result.items }
      },
    },
    { label: '联想', argsHint: 'mem_associate({ record_id? | query?, top_k? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_read',
      description: '按 record_id 读全文。S 级记录默认只返回摘要与哈希，需要 include_sensitive=true 才给正文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_id: { type: 'string', description: '记录 ID（ULID）' },
          include_sensitive: { type: 'boolean', description: 'S 级是否返回正文' },
        },
        required: ['record_id'],
      },
      output: {
        schema: textOut({
          record: { type: 'object', additionalProperties: true },
          denied: { type: 'boolean' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const record = store.read(String(args?.record_id ?? ''), { includeSensitive: args?.include_sensitive === true })
        if (!record) return { text: `没有找到记录 ${args?.record_id}`, record: {}, denied: false }
        if (record.denied) {
          return {
            text: [
              `记录 ${record.record_id}（${record.layer}/${record.sad_level}）被权限拦下：${record.reason}`,
              `摘要：${record.summary}`,
              `哈希：${record.content_hash}`,
            ].join('\n'),
            record,
            denied: true,
          }
        }
        return {
          text: [
            `${record.record_id}（${record.layer}/${record.sad_level}/${record.trust_level}/${record.status}）`,
            `来源 ${record.source_channel}，写入 ${record.created_at}`,
            `哈希 ${record.content_hash}`,
            '',
            record.content,
          ].join('\n'),
          record,
          denied: false,
        }
      },
    },
    { label: '读全文', argsHint: 'mem_read({ record_id, include_sensitive? })', needsOpen: true },
  )

  // ---------- 可注入：评分与审核（写入链的配套出口） ----------

  add(
    {
      name: 'mem_judge',
      description:
        '给一条记忆补评 α（重要度 0.01–1）与 β（可信度 0–1）。评分不阻塞写入：未评分的记忆可以召回，' +
        '但注入时会带"未评分"标记，且 β 不参与权重。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_id: { type: 'string', description: '记录 ID' },
          alpha: { type: 'number', description: '重要度 0.01–1' },
          beta: { type: 'number', description: '可信度 0–1' },
        },
        required: ['record_id'],
      },
      output: {
        schema: textOut({
          record_id: { type: 'string' },
          alpha: { type: 'string' },
          beta: { type: 'string' },
          scored: { type: 'boolean' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const r = store.judge(String(args?.record_id ?? ''), { alpha: args?.alpha, beta: args?.beta })
        return {
          text: `已评分 ${r.record_id}：α=${r.alpha ?? '—'}，β=${r.beta ?? '—'}`,
          record_id: r.record_id,
          alpha: String(r.alpha ?? ''),
          beta: String(r.beta ?? ''),
          scored: true,
        }
      },
    },
    { label: '评分', argsHint: 'mem_judge({ record_id, alpha?, beta? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_review',
      description:
        '审核待审区/隔离区的记录。approve / release → 回到 active（参与召回）；reject → 标记 rejected（保留正文，不物理删除）。' +
        '没有这个出口，隔离区会变成垃圾场。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_id: { type: 'string', description: '记录 ID' },
          decision: { type: 'string', enum: ['approve', 'reject', 'release'], description: 'approve=通过 / reject=否决 / release=解除隔离' },
          note: { type: 'string', description: '决定理由（记入 review_queue）' },
        },
        required: ['record_id', 'decision'],
      },
      output: {
        schema: textOut({
          record_id: { type: 'string' },
          status: { type: 'string' },
          decision: { type: 'string' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const r = store.review(String(args?.record_id ?? ''), String(args?.decision ?? ''), args?.note ?? null)
        return { text: `${r.record_id} 已 ${r.decision}，当前状态 ${r.status}`, record_id: r.record_id, status: r.status, decision: r.decision }
      },
    },
    { label: '审核', argsHint: 'mem_review({ record_id, decision: approve|reject|release, note? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_pending',
      description: '列待审区与隔离区（pending / quarantined），含原因与冲突对象。审核前先看这个。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 20' },
        },
      },
      output: {
        schema: textOut({
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'integer' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const items = store.pendingReview(args?.limit)
        const text = items.length === 0
          ? '待审区与隔离区都是空的。'
          : items
              .map((r, i) => `${i + 1}. ${r.record_id} [${r.status}/${r.sad_level}/${r.trust_level}] ${r.summary ?? ''}${r.reason ? `（${r.reason}）` : ''}`)
              .join('\n')
        return { text, items, count: items.length }
      },
    },
    { label: '待审清单', argsHint: 'mem_pending({ limit? })', needsOpen: true },
  )

  // ---------- 交接与体检（迁移自 luanyujia-workbench 记忆机制） ----------

  const SECTION_LABELS = {
    last: '1) 上次交接',
    projects: '2) 当前项目',
    changes: '3) 私有记忆变更',
    next: '4) 下一步',
    blockers: '5) 卡点',
  }
  const renderSections = (sections) =>
    ['last', 'projects', 'changes', 'next', 'blockers']
      .filter((k) => sections && sections[k])
      .map((k) => `### ${SECTION_LABELS[k]}\n${sections[k]}`)
      .join('\n\n')

  add(
    {
      name: 'mem_handoff',
      description:
        '读写场景的「§〇 交接」：覆盖写、只留最新一份、≤4 KB、五小节固定键（last / projects / changes / next / blockers）。' +
        '换会话前必须先写交接；写不出"下一步"说明这轮白干了。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', description: '场景名（通常是项目 id）' },
          mode: { type: 'string', enum: ['read', 'write'], description: 'read 读取（默认）/ write 覆盖写' },
          title: { type: 'string', description: '可选标题' },
          sections: {
            type: 'object',
            additionalProperties: false,
            description: '五小节（写模式必填至少一节）',
            properties: {
              last: { type: 'string', description: '上次交接：做了什么 / 结果 / 证据' },
              projects: { type: 'string', description: '当前项目表' },
              changes: { type: 'string', description: '私有记忆变更' },
              next: { type: 'string', description: '下一步' },
              blockers: { type: 'string', description: '卡点（没有就写"无"）' },
            },
          },
        },
        required: ['scene'],
      },
      output: {
        schema: textOut({
          scene: { type: 'string' },
          bytes: { type: 'integer' },
          updated_at: { type: 'string' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const scene = String(args?.scene ?? '').trim()
        if (!scene) return { text: '需要 scene 参数。', scene: '', bytes: 0, updated_at: '' }
        if (args?.mode === 'write') {
          const r = store.handoffWrite({ scene, title: args?.title ?? null, sections: args?.sections ?? {} })
          return {
            text: `已覆盖写 ${scene} 的 §〇 交接（${r.bytes}/4096 字节，${r.updated_at}）\n\n${renderSections(r.sections)}`,
            scene,
            bytes: r.bytes,
            updated_at: r.updated_at,
          }
        }
        const h = store.handoffRead(scene)
        if (!h) return { text: `场景 ${scene} 还没有交接。`, scene, bytes: 0, updated_at: '' }
        return {
          text: `${renderSections(h.sections)}\n\n（${h.bytes}/4096 字节，更新于 ${h.updated_at}）`,
          scene,
          bytes: h.bytes,
          updated_at: h.updated_at,
        }
      },
    },
    { label: '场景交接', argsHint: 'mem_handoff({ scene, mode?, sections? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_check',
      description:
        '体量体检：交接 ≤4 KB、场景记忆 ≤25 KB、待审 ≤20、审计链一致。换会话前跑一次，不过就别换。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', description: '只看某个场景（可选）' },
        },
      },
      output: {
        schema: textOut({
          ok: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const r = store.checkBudgets(args?.scene ?? null)
        const lines = r.items.map((i) => `${i.ok ? '✓' : '✗'} ${i.name}: ${i.value}/${i.limit}`)
        return {
          text: lines.join('\n') + (r.ok ? '\n\n全部在红线内。' : '\n\n有超线项：先减肥（历史搬归档），再换会话。'),
          ok: r.ok,
          items: r.items,
        }
      },
    },
    { label: '体量体检', argsHint: 'mem_check({ scene? })', needsOpen: true },
  )

  // ---------- 协作：派单 / 回执 / 台账 / 修改权 ----------

  add(
    {
      name: 'mem_dispatch',
      description:
        '建一条派单（要对方动手）或公告（只知悉）。派单四件套缺一不可：现象 / 照哪做 / 怎么验 / 回一句；' +
        '公告不需要四件套，但也不会唤醒对方。派单默认 24 小时未回执进 overdue。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['dispatch', 'notice'], description: 'dispatch=派单（默认）/ notice=公告' },
          from: { type: 'string', description: '发起方场景' },
          to: { type: 'string', description: '执行方场景' },
          title: { type: 'string', description: '一句话标题' },
          phenomenon: { type: 'string', description: '① 现象：现在什么样（可观察，不要形容词）' },
          how_to: { type: 'string', description: '② 照哪做：文档哪一节 / 哪个工具（唯一出处）' },
          how_verify: { type: 'string', description: '③ 怎么验：跑什么、看到什么算通过' },
          deadline_minutes: { type: 'integer', description: '超时阈值（分钟），默认 1440' },
        },
        required: ['from', 'to', 'title'],
      },
      output: {
        schema: textOut({ task_id: { type: 'string' }, status: { type: 'string' }, deadline_at: { type: 'string' } }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const t = store.dispatchCreate({
          kind: args?.kind ?? 'dispatch',
          from: args?.from,
          to: args?.to,
          title: args?.title,
          phenomenon: args?.phenomenon,
          howTo: args?.how_to,
          howVerify: args?.how_verify,
          deadlineMinutes: args?.deadline_minutes,
        })
        return {
          text:
            `已建 ${t.kind === 'dispatch' ? '派单' : '公告'} ${t.task_id}\n` +
            `  ${t.from_scene} → ${t.to_scene}：${t.title}\n` +
            `  状态 ${t.status}${t.deadline_at ? '，回执期限 ' + t.deadline_at : ''}\n` +
            (t.kind === 'dispatch' ? '  记得在正文里写「我在等你的回执」。' : '  公告只落盘，不唤醒。'),
          task_id: t.task_id,
          status: t.status,
          deadline_at: t.deadline_at ?? '',
        }
      },
    },
    { label: '派单', argsHint: 'mem_dispatch({ kind?, from, to, title, phenomenon?, how_to?, how_verify? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_receipt',
      description:
        '给一条派单回执：结论 + 证据 + 落盘路径（+ 还差什么）。只在自己窗口说"做完了"等于没交付；' +
        '同一件事最多 3 条消息，到上限会拒绝。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: '派单 id' },
          conclusion: { type: 'string', description: '结论（一行）' },
          evidence: { type: 'string', description: '证据：跑了什么、几条通过、差异集合' },
          path: { type: 'string', description: '落盘路径（回执给指针，报告放文件）' },
          remaining: { type: 'string', description: '还差什么（没有就不填）' },
        },
        required: ['task_id', 'conclusion', 'evidence'],
      },
      output: {
        schema: textOut({ task_id: { type: 'string' }, status: { type: 'string' } }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const t = store.taskReceipt({
          taskId: args?.task_id,
          conclusion: args?.conclusion,
          evidence: args?.evidence,
          path: args?.path,
          remaining: args?.remaining,
        })
        return {
          text: `已回执 ${t.task_id}（${t.status}）。\n结论：${t.ack.conclusion}\n证据：${t.ack.evidence}`,
          task_id: t.task_id,
          status: t.status,
        }
      },
    },
    { label: '回执', argsHint: 'mem_receipt({ task_id, conclusion, evidence, path?, remaining? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_task',
      description:
        '派单台账：scope=outbound 看我发出没回的；inbound 看别人等我回的；open 看全部未办结。' +
        '带 task_id + status 时推进状态（delivered / done / failed / closed）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', description: '场景名（outbound/inbound 必填）' },
          scope: { type: 'string', enum: ['outbound', 'inbound', 'open', 'all'], description: '默认 open' },
          task_id: { type: 'string', description: '要推进状态的任务 id' },
          status: { type: 'string', enum: ['delivered', 'done', 'failed', 'closed'], description: '目标状态' },
        },
      },
      output: {
        schema: textOut({
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'integer' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        if (args?.task_id && args?.status) {
          const t = store.taskMark({ taskId: args.task_id, status: args.status })
          return { text: `${t.task_id} → ${t.status}`, items: [t], count: 1 }
        }
        const items = store.taskList({ scene: args?.scene ?? null, scope: args?.scope ?? 'open' })
        const text = items.length === 0
          ? '台账是空的。'
          : items
              .map((t) => {
                const flag = t.overdue ? '⚠ 超时未回执' : t.effective_status
                return `- ${t.task_id} [${t.kind}/${flag}] ${t.from_scene} → ${t.to_scene}：${t.title}`
              })
              .join('\n')
        return { text, items, count: items.length }
      },
    },
    { label: '派单台账', argsHint: 'mem_task({ scene?, scope?, task_id?, status? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_scope',
      description:
        '修改权判定（A 宪法 / C 工具 / B 板 / D 自己 / E 别人）：告诉我这个 actor 能不能写这个目标，' +
        '越界时给出"写请求"的写法。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          actor: { type: 'string', description: '谁在写（场景名）' },
          target: { type: 'string', description: '写谁的东西（场景名）' },
          kind: { type: 'string', enum: ['rule', 'tool', 'board', 'own'], description: '默认 own' },
          rule_owner: { type: 'string', description: 'A/C 档负责人（可选）' },
          row_owner: { type: 'string', description: 'B 档行归属（可选）' },
        },
        required: ['actor', 'target'],
      },
      output: {
        schema: textOut({
          tier: { type: 'string' },
          allowed: { type: 'boolean' },
          reason: { type: 'string' },
          request: { type: 'string' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const r = canWrite({
          actor: args?.actor,
          target: args?.target,
          kind: args?.kind ?? 'own',
          ruleOwner: args?.rule_owner ?? null,
          rowOwner: args?.row_owner ?? null,
        })
        return {
          text: `${r.allowed ? '✓ 可以写' : '✗ 不能写'}（${r.tier} 档）：${r.reason}${r.request ? '\n' + r.request : ''}`,
          tier: r.tier,
          allowed: r.allowed,
          reason: r.reason,
          request: r.request ?? '',
        }
      },
    },
    { label: '修改权判定', argsHint: 'mem_scope({ actor, target, kind?, rule_owner?, row_owner? })', needsOpen: true },
  )

  // ---------- 二期：导入 / 影子读 / 回放 / 审计 ----------

  add(
    {
      name: 'mem_import',
      description:
        '把旧记忆（~/.mnemon 的 memories.json 与 documents）只读导入本库。凭证类正文替换成 «REDACTED:kind» 并记 S 级，' +
        '原值留在原处；按内容哈希去重，重复跑不会重复导入。dry_run=true 只算不写。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dry_run: { type: 'boolean', description: '只统计不写库' },
          home: { type: 'string', description: '旧记忆根目录，缺省 ~/.mnemon' },
        },
      },
      output: {
        schema: textOut({
          imported: { type: 'integer' },
          skipped: { type: 'integer' },
          redacted: { type: 'integer' },
          dry_run: { type: 'boolean' },
          errors: { type: 'integer' },
          report: { type: 'object', additionalProperties: true },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const report = store.importLegacy({ dryRun: args?.dry_run === true, home: args?.home })
        const lines = [
          `${report.dry_run ? '【演练】' : ''}扫描：记忆 ${report.scanned.memory} 条 / 文档 ${report.scanned.documents} 条`,
          `导入 ${report.imported} · 跳过(已存在) ${report.skipped} · 脱敏 ${report.redacted} 条`,
          report.redacted_kinds && Object.keys(report.redacted_kinds).length
            ? `脱敏类型：${Object.entries(report.redacted_kinds).map(([k, v]) => `${k}×${v}`).join('、')}`
            : '脱敏类型：无',
          `分层：${Object.entries(report.by_layer).map(([k, v]) => `${k}:${v}`).join(' ') || '（无）'}`,
        ]
        if (report.errors.length) {
          lines.push(`错误 ${report.errors.length} 条：`)
          for (const e of report.errors.slice(0, 5)) lines.push(`  - ${e.ref}: ${e.reason}`)
        }
        return {
          text: lines.join('\n'),
          imported: report.imported,
          skipped: report.skipped,
          redacted: report.redacted,
          dry_run: report.dry_run,
          errors: report.errors.length,
          report,
        }
      },
    },
    { label: '导入旧记忆', argsHint: 'mem_import({ dry_run?, home? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_shadow',
      description:
        '影子读：同一次查询同时走旧记忆（~/.mnemon）与本库，并排给出结果与差异（只有旧有 / 只有新有 / 都有）。' +
        'authority=shadow 时用它确认"新库没有漏掉旧记忆"。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '查询词' },
          top_k: { type: 'integer', description: '每路返回条数，默认 5' },
          home: { type: 'string', description: '旧记忆根目录，缺省 ~/.mnemon' },
        },
        required: ['query'],
      },
      output: {
        schema: textOut({
          legacy: { type: 'array', items: { type: 'object', additionalProperties: true } },
          mine: { type: 'array', items: { type: 'object', additionalProperties: true } },
          consistent: { type: 'boolean' },
          only_legacy: { type: 'integer' },
          only_new: { type: 'integer' },
          both: { type: 'integer' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const r = store.shadow({ query: args?.query, topK: args?.top_k, home: args?.home })
        const lines = [
          `查询：${r.query}    旧库 ${r.legacy_count} 条 / 新库 ${r.mine.length} 条命中`,
          `一致性：${r.consistent ? '旧库命中项都能在新库找到' : `有 ${r.diff.only_legacy.length} 条旧库命中项在新库缺失`}`,
          `交集 ${r.diff.both.length} · 只有旧 ${r.diff.only_legacy.length} · 只有新 ${r.diff.only_new.length}`,
          '',
          '旧：',
          ...(r.legacy.length ? r.legacy.map((h, i) => `  ${i + 1}. [${h.legacy_id}] ${h.snippet}${h.record_id ? ` → ${h.record_id}` : ' （新库无对应）'}`) : ['  （无）']),
          '新：',
          ...(r.mine.length ? r.mine.map((h, i) => `  ${i + 1}. ${h.record_id}  ${h.snippet}`) : ['  （无）']),
        ]
        return {
          text: lines.join('\n'),
          legacy: r.legacy,
          mine: r.mine,
          consistent: r.consistent,
          only_legacy: r.diff.only_legacy.length,
          only_new: r.diff.only_new.length,
          both: r.diff.both.length,
        }
      },
    },
    { label: '影子读', argsHint: 'mem_shadow({ query, top_k?, home? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_prompt_inspector',
      description: '按 trace_id 回放：那次操作的参数摘要、命中了哪些记录、耗时、以及哈希链上的前后指针。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trace_id: { type: 'string', description: '记录仪里的 trace_id' },
        },
        required: ['trace_id'],
      },
      output: {
        schema: textOut({
          trace: { type: 'object', additionalProperties: true },
          found: { type: 'boolean' },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const trace = store.traceLookup(String(args?.trace_id ?? ''))
        if (!trace) return { text: `没有找到 trace ${args?.trace_id}（记录仪里没有这一条）`, trace: {}, found: false }
        const lines = [
          `trace ${trace.trace_id}  #${trace.seq}`,
          `操作 ${trace.op}    时间 ${trace.at}`,
          `查询：${trace.query_preview ?? '（无）'}${trace.query_hash ? `\n查询哈希 ${trace.query_hash.slice(0, 16)}…` : ''}`,
          `命中 ${trace.hits.length} 条：${trace.hits.slice(0, 8).join(', ') || '（无）'}`,
          `token：入 ${trace.tokens_in ?? '—'} / 出 ${trace.tokens_out ?? '—'}    耗时 ${trace.duration_ms ?? '—'} ms`,
          `哈希链：prev ${String(trace.prev_hash ?? '').slice(0, 12)}… → hash ${String(trace.hash ?? '').slice(0, 12)}…`,
        ]
        return { text: lines.join('\n'), trace, found: true }
      },
    },
    { label: '注入回放', argsHint: 'mem_prompt_inspector({ trace_id })', needsOpen: true },
  )

  add(
    {
      name: 'mem_audit',
      description: '记录仪体检：校验哈希链（deep=true 逐行重算）、统计行数与体积、列出最近 5 条 trace。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deep: { type: 'boolean', description: '逐行重算整条链（慢，但能定位断点）' },
        },
      },
      output: {
        schema: textOut({
          ok: { type: 'boolean' },
          lines: { type: 'integer' },
          files: { type: 'integer' },
          broken_at: { type: 'string' },
          recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const a = store.audit({ deep: args?.deep === true })
        const lines = [
          `哈希链：${a.ok ? '一致' : `断链（${a.brokenAt?.file ?? '?'} ${a.brokenAt?.reason ?? ''}）`}`,
          `记录 ${a.lines} 行 / ${a.files} 个文件 / ${(a.bytes / 1024).toFixed(1)} KB`,
          `最近 trace：`,
          ...(a.recent.length ? a.recent.map((t) => `  #${t.trace_id} ${t.op} ${t.at}`) : ['  （无）']),
        ]
        return { text: lines.join('\n'), ok: Boolean(a.ok), lines: a.lines, files: a.files, broken_at: a.brokenAt ? JSON.stringify(a.brokenAt) : '', recent: a.recent }
      },
    },
    { label: '记录仪体检', argsHint: 'mem_audit({ deep? })', needsOpen: true },
  )

  // ---------- 账本 / 健康线（补齐自实施单 5.2 / 5.3） ----------

  add(
    {
      name: 'mem_ledger',
      description: '文本账本：init 拍快照、sync 只补新记录、verify 校验每条正文指纹。先 sync 再 verify。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string', enum: ['init', 'sync', 'verify'] } },
        required: ['action'],
      },
      output: { schema: textOut({ result: { type: 'object', additionalProperties: true } }), render: renderText },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const action = String(args?.action ?? 'verify')
        if (action === 'init') {
          const r = ledgerInit({ store })
          return { text: '账本已初始化：' + r.initialized + ' 条\n' + r.path, result: r }
        }
        if (action === 'sync') {
          const r = ledgerSync({ store })
          return { text: '账本已同步：新增 ' + r.added + ' 条，共 ' + r.total + ' 条', result: r }
        }
        const r = ledgerVerify({ store })
        return {
          text: r.ok ? '账本校验通过：' + r.total + ' 条全部一致' : '账本校验失败：丢失 ' + r.missing.length + ' 条，被改 ' + r.changed.length + ' 条',
          result: r,
        }
      },
    },
    { label: '账本', argsHint: 'mem_ledger({ action: init|sync|verify })', needsOpen: true },
  )

  add(
    {
      name: 'mem_health',
      description: '每日健康一行：记录数 / 待审 / 账本 / 审计链，一眼看全线是否正常。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: textOut({ line: { type: 'string' } }), render: renderText },
      isConcurrencySafe: () => true,
      execute: async () => {
        const line = healthLine({ store })
        return { text: line, line }
      },
    },
    { label: '健康一行', argsHint: 'mem_health({})', needsOpen: true },
  )

  // ---------- 四期：加密 ----------

  add(
    {
      name: 'mem_crypto',
      description: '静态加密：status 看状态、enable 生成密钥、encrypt/decrypt 单条记录。只加密 content，摘要与标签保持明文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'enable', 'encrypt', 'decrypt'] },
          record_id: { type: 'string' },
        },
        required: ['action'],
      },
      output: { schema: textOut({ result: { type: 'object', additionalProperties: true } }), render: renderText },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const action = String(args?.action ?? 'status')
        if (action === 'status') {
          const s = store.cryptoStatus()
          return { text: '加密：' + (s.enabled ? '已启用' : '未启用') + '\n密钥：' + s.keyPath, result: s }
        }
        if (action === 'enable') {
          const s = store.enableCrypto()
          return { text: '加密已启用' + (s.created ? '（已生成新密钥）' : '（沿用已有密钥）') + '\n密钥：' + s.keyPath, result: s }
        }
        const id = String(args?.record_id ?? '')
        if (!id) return { text: 'record_id 必填', result: {} }
        const r = action === 'encrypt' ? store.encryptRecord(id) : store.decryptRecord(id)
        return { text: (r.encrypted ? '已加密 ' : '已解密 ') + r.record_id, result: r }
      },
    },
    { label: '加密', argsHint: 'mem_crypto({ action: status|enable|encrypt|decrypt, record_id? })', needsOpen: true },
  )

  // ---------- 图查询（v9 实现：标签/同批次共现） ----------

  add(
    {
      name: 'mem_graph_view',
      description: '图邻域：从一条记忆出发，按标签/同批次共现关系做 BFS，返回邻近记忆与边（hops 1-3）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_id: { type: 'string', description: '起点记录 ID' },
          hops: { type: 'integer', description: '跳数，默认 1，最多 3' },
          edge_types: { type: 'array', items: { type: 'string' }, description: '只保留这些边类型（tag/batch）' },
          rebuild: { type: 'boolean', description: '是否先重建全量边' },
        },
        required: ['record_id'],
      },
      output: {
        schema: textOut({
          root: { type: 'string' },
          nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          edges: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        if (args?.rebuild || store.db.prepare('SELECT COUNT(*) AS n FROM edges').get().n === 0) store.buildEdges()
        const result = store.graphNeighbors(String(args?.record_id ?? ''), {
          hops: args?.hops ?? 1,
          edgeTypes: args?.edge_types ?? null,
        })
        const lines = [`起点 ${result.root}：${result.nodes.length - 1} 个邻近记忆，${result.edges.length} 条边`]
        for (const node of result.nodes.filter((n) => n.depth > 0).slice(0, 20)) {
          lines.push(`- [d${node.depth}] ${node.record_id} [${node.layer}] ${String(node.summary ?? '').slice(0, 50)}`)
        }
        return { text: lines.join('\n'), root: result.root, nodes: result.nodes, edges: result.edges }
      },
    },
    { label: '图邻域', argsHint: 'mem_graph_view({ record_id, hops?, edge_types?, rebuild? })', needsOpen: true },
  )

  add(
    {
      name: 'mem_graph_traverse',
      description: '图扩散：从多个种子记忆出发一起做 BFS，返回合并后的节点与边（去重）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seed_ids: { type: 'array', items: { type: 'string' }, description: '种子记录 ID 列表' },
          hops: { type: 'integer', description: '跳数，默认 2，最多 3' },
          edge_types: { type: 'array', items: { type: 'string' }, description: '只保留这些边类型' },
          rebuild: { type: 'boolean', description: '是否先重建全量边' },
        },
        required: ['seed_ids'],
      },
      output: {
        schema: textOut({
          seeds: { type: 'array', items: { type: 'string' } },
          nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          edges: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: renderText,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        if (args?.rebuild || store.db.prepare('SELECT COUNT(*) AS n FROM edges').get().n === 0) store.buildEdges()
        const seeds = Array.isArray(args?.seed_ids) ? args.seed_ids.map(String) : []
        const result = store.graphTraverse(seeds, { hops: args?.hops ?? 2, edgeTypes: args?.edge_types ?? null })
        const lines = [`种子 ${result.seeds.length} 个 → 节点 ${result.nodes.length} 个，边 ${result.edges.length} 条`]
        for (const node of result.nodes.slice(0, 25)) {
          lines.push(`- ${node.record_id} [${node.layer}] ${String(node.summary ?? '').slice(0, 50)}`)
        }
        return { text: lines.join('\n'), seeds: result.seeds, nodes: result.nodes, edges: result.edges }
      },
    },
    { label: '图扩散', argsHint: 'mem_graph_traverse({ seed_ids, hops?, edge_types?, rebuild? })', needsOpen: true },
  )

  // ---------- 未实现项：显式 degraded，不伪造 ----------

  const stub = (name, label, hint, reason) =>
    add(
      {
        name,
        description: `${label}（未实现）`,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: textOut({ degraded: { type: 'boolean' }, reason: { type: 'string' } }), render: renderText },
        isConcurrencySafe: () => true,
        execute: async () => ({ text: `${name} 暂不可用：${reason}`, degraded: true, reason }),
      },
      { label, argsHint: hint, needsOpen: true, ready: false },
    )

  stub('mem_archive', '降层归档', 'mem_archive({ record_id, target_depth })', '降层与回升指针排在认知层（三期）')
  stub('mem_fetch_media', '拉取媒体', 'mem_fetch_media({ record_id })', '加密与 R2 在四期')

  return registry
}
