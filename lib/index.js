/**
 * dsh-memory-core — 六层记忆底座的 host 半边。
 *
 * 一期原则（见《一期执行清单》）：
 *  - 默认只常驻 mem_admin_catalog；其余工具按需注入，用完卸载。
 *  - 库打不开时不自吹：注册一个 degraded 目录，把真实错误说出来。
 *  - 不碰任何外部记忆文件（MEMORY.md / mnemon）—— 只读引用在 W4 的导入器里做。
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import MemoryStore from './memory/store.js'
import { buildRegistry } from './memory/tools.js'
import { Injector } from './memory/inject.js'
import { attachLifecycle, lifecycleSummary } from './memory/lifecycle.js'
import { decorateRows, explainRecord } from './memory/explain.js'
import { readDetail } from './memory/detail.js'
import { createQqBridge } from './memory/qq.js'
import { createApiHandler, ensureApiToken, createApiServer } from './memory/api.js'
import { createQqOfficialBridge } from './memory/qq-official.js'
import { ingestQqSessions, affectReport } from './memory/affect-events.js'
import { timeline } from './memory/timeline.js'
import { ledgerSync, ledgerVerify, healthLine } from './memory/ledger.js'
import { saveAffectReport } from './memory/affect-report.js'
import { notifyAffectSpike } from './memory/affect-alert.js'
import { sendReport } from './memory/notify.js'
import { listParts } from './parts/index.js'
import { searchLibrary, catalogMeta } from './parts/library.js'
import { installPart, uninstallPart, listInstalled, resetActive } from './parts/installer.js'
import { startJob, getJob, cancelJob } from './parts/jobs.js'

export const name = 'memory-core'

// 注意：不能把 connection 写成必需依赖 —— 这个宿主里拿不到该服务，
// 插件会一直 pending，连工具都不注册（2026-10-31 实测）。
// 改为启动时延迟重试 + 诊断日志。
export const inject = ['tools', 'systemPrompt']

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 诊断日志：插件加载/注册的每一步都落盘，出问题不靠猜。
const DIAG_FILE = path.join(HERE, '..', 'docs', '_rpc-diag.log')
function diag(message) {
  try {
    fs.appendFileSync(DIAG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 诊断写失败不影响主流程 */
  }
}

/** 工具宿主：负责动态注入与卸载，保证不会重复注册。 */
class ToolHost {
  constructor(ctx) {
    this.ctx = ctx
    this.disposers = new Map()
  }

  open(names) {
    for (const toolName of names) {
      if (this.disposers.has(toolName)) continue
      const definition = this.definitions?.get(toolName)
      if (!definition) continue
      const dispose = this.ctx.tools.register(definition)
      this.disposers.set(toolName, dispose)
    }
    return this.injected()
  }

  injected() {
    return [...this.disposers.keys()]
  }

  closeAll() {
    for (const dispose of this.disposers.values()) {
      try {
        dispose()
      } catch {
        /* 卸载失败不阻断 */
      }
    }
    this.disposers.clear()
  }
}

function resolveQqOfficialConfig(cfg, dataDir) {
  const base = { enabled: false, sandbox: false, prefix: '/', allowedOpenids: [], ...(cfg ?? {}) }
  if (!base.appSecret || !base.appId) {
    try {
      const file = path.join(dataDir, 'meta', 'qq-bot.json')
      const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (!base.appId && json.appId) base.appId = String(json.appId)
      if (!base.appSecret && json.appSecret) base.appSecret = String(json.appSecret)
      if (json.sandbox !== undefined && cfg?.sandbox === undefined) base.sandbox = Boolean(json.sandbox)
      if (!Array.isArray(base.allowedOpenids) || base.allowedOpenids.length === 0) {
        if (Array.isArray(json.allowedOpenids)) base.allowedOpenids = json.allowedOpenids
      }
    } catch {
      /* 没有文件就保持原样 */
    }
  }
  return base
}

function resolveDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim()) return path.resolve(config.dataDir)
  if (process.env.DSH_MEMORY_DATA_DIR) return path.resolve(process.env.DSH_MEMORY_DATA_DIR)
  // 没有配置时的自愈默认：仓库旁的 dsh-memory-data 存在就用它（当前布局），否则退回用户目录
  const besideRepo = path.resolve(HERE, '..', '..', 'dsh-memory-data')
  try {
    if (fs.existsSync(besideRepo)) return besideRepo
  } catch {
    /* 忽略 */
  }
  return path.join(os.homedir(), '.dsh', 'memory-core-data')
}

function resolveAuthority(config) {
  const fromConfig = config && typeof config.authority === 'string' ? config.authority : null
  const fromEnv = process.env.DSH_MEMORY_AUTHORITY ?? null
  return fromConfig || fromEnv || 'shadow'
}

function degradedCatalog(error, dataDir) {
  return {
    name: 'mem_admin_catalog',
    description: '六层记忆底座的能力目录（当前降级：库打不开）',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, degraded: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    execute: async () => ({
      text: [
        'memory-core 处于降级状态：记忆库打不开，所有记忆工具不可用。',
        `原因：${error?.message ?? String(error)}`,
        `数据目录：${dataDir}`,
        '处理：检查该目录是否可写、是否被另一个进程占用（WAL 锁），然后重启 DSH。',
      ].join('\n'),
      degraded: true,
      reason: error?.message ?? String(error),
    }),
  }
}

/** @param {any} ctx @param {{dataDir?:string, authority?:string}} [config] */
export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config)
  const authority = resolveAuthority(config)
  const logger = ctx.logger
  diag('apply start: dataDir=' + dataDir)

  let store = null
  let openError = null
  try {
    store = new MemoryStore({ dataDir, authority }).open()
    diag('store open ok: schema=' + store.getMeta('schema_version'))
  } catch (error) {
    openError = error
    diag('store open FAILED: ' + (error?.message ?? String(error)))
    logger?.warn?.(`memory-core: 记忆库打开失败（进入降级）：${error?.message ?? error}`)
  }

  // 每轮注入器：默认 3 条 / 500 字 / 同源最多 1 条（P1 组合检查）
  const injector = store
    ? new Injector({
        store,
        affect: config.affect?.hint === false ? null : { hours: Number(config.affect?.hours ?? 3), threshold: Number(config.affect?.threshold ?? 2) },
      })
    : null
  diag('injector ' + (injector ? 'ok' : 'skipped'))

  // QQ 机器人桥（OneBot v11 WebSocket 客户端）：只有显式开 enabled 才连
  const qq = store ? createQqBridge({ store, config: config.qq ?? {}, log: (m) => diag(m) }) : null
  if (qq && qq.enabled) {
    try {
      ctx.effect(() => {
        qq.start()
        diag('qq: 桥已启动 wsUrl=' + String(config.qq?.wsUrl ?? ''))
        return () => {
          qq.stop()
          diag('qq: 桥已停止')
        }
      })
    } catch (error) {
      diag('qq: 启动失败 ' + (error?.message ?? String(error)))
    }
  } else if (qq) {
    diag('qq: 未启用（config.qq.enabled=true 才连）')
  }

  // QQ 官方机器人（QQ Bot v2）：AppSecret 从配置或 meta/qq-bot.json 读
  let qqOfficial = null
  const qqOfficialConfig = resolveQqOfficialConfig(config.qqOfficial, dataDir)
  if (store && qqOfficialConfig.enabled) {
    qqOfficial = createQqOfficialBridge({ store, config: qqOfficialConfig, log: (m) => diag(m) })
    if (qqOfficial.enabled) {
      try {
        ctx.effect(() => {
          qqOfficial.start()
          diag('qq-official: 已启动 appId=' + String(qqOfficialConfig.appId))
          return () => {
            qqOfficial.stop()
            diag('qq-official: 已停止')
          }
        })
      } catch (error) {
        diag('qq-official: 启动失败 ' + (error?.message ?? String(error)))
      }
    } else {
      diag('qq-official: 缺少 appSecret，未启动（填 meta/qq-bot.json）')
    }
  }

  // 情绪事件采集：每 10 分钟扫一次 QQ 会话（config.affect.enabled=false 可关）
  if (store && config.affect?.enabled !== false) {
    const runIngest = () => {
      try {
        const r = ingestQqSessions({ store, sessionsRoot: config.affect?.sessionsRoot, limit: config.affect?.limit ?? 10 })
        if (r.added > 0) diag('affect: 采集新增 ' + r.added + ' 条（扫描 ' + r.scanned + '）')
      } catch (error) {
        diag('affect: 采集失败 ' + (error?.message ?? String(error)))
      }
    }
    runIngest()
    const affectTimer = setInterval(runIngest, Number(config.affect?.pollMs ?? 600000))
    affectTimer.unref?.()
    ctx.effect(() => () => clearInterval(affectTimer))
  }

  // 二期：日报/周报落盘（每 6 小时；周一 9 点补周报）
  if (store && config.affect?.enabled !== false) {
    const runReport = () => {
      try {
        saveAffectReport({ store, dataDir, range: 'day' })
        const now = new Date()
        if (now.getDay() === 1 && now.getHours() === 9) saveAffectReport({ store, dataDir, range: 'week' })
        try {
          ledgerSync({ store })
          const line = healthLine({ store })
          const dir = path.join(dataDir, 'reports')
          fs.mkdirSync(dir, { recursive: true })
          fs.appendFileSync(path.join(dir, 'health.log'), line + '\n', 'utf8')
        } catch (error) {
          diag('health: 写入失败 ' + (error?.message ?? String(error)))
        }
      } catch (error) {
        diag('affect: 报告写入失败 ' + (error?.message ?? String(error)))
      }
    }
    runReport()
    const reportTimer = setInterval(runReport, 6 * 3600 * 1000)
    reportTimer.unref?.()
    ctx.effect(() => () => clearInterval(reportTimer))

    // 三期：情绪尖峰主动通知（默认走现有邮件/飞书通道，6 小时冷却）
    if (config.affect?.notify !== false) {
      const runAlert = () => {
        notifyAffectSpike({
          store,
          notify: (msg) => sendReport(msg),
          options: { hours: Number(config.affect?.hours ?? 3), threshold: Number(config.affect?.threshold ?? 2) },
        })
          .then((r) => {
            if (r.sent) diag('affect: 已发送情绪提醒')
          })
          .catch(() => {})
      }
      runAlert()
      const alertTimer = setInterval(runAlert, 30 * 60 * 1000)
      alertTimer.unref?.()
      ctx.effect(() => () => clearInterval(alertTimer))
    }
  }

  // 对外 HTTP API（token 鉴权）：config.api.enabled 才开，默认只读
  let apiHandler = null
  if (store && config.api?.enabled) {
    try {
      const apiToken = ensureApiToken({ dataDir, configured: config.api?.token })
      apiHandler = createApiHandler({ store, token: apiToken, allowWrite: config.api?.allowWrite === true })
      diag('api: 已启用（写入=' + (config.api?.allowWrite === true ? '开' : '关') + '）')
    } catch (error) {
      diag('api: 启用失败 ' + (error?.message ?? String(error)))
    }
  }

  // 固定端口监听（可选）：config.api.port；不配就只走 DSH webServer 的随机端口
  if (apiHandler && Number(config.api?.port) > 0) {
    try {
      const apiServer = createApiServer({ handler: apiHandler })
      apiServer.listen(Number(config.api.port), '127.0.0.1')
      ctx.effect(() => () => {
        try {
          apiServer.close()
        } catch {
          /* 忽略 */
        }
      })
      diag('api: 固定端口监听 127.0.0.1:' + config.api.port)
    } catch (error) {
      diag('api: 固定端口启动失败 ' + (error?.message ?? String(error)))
    }
  }

  // 注意：服务注册被刻意放到工具注册之后（见文件末尾）。
  // 服务化是增值功能，不能因为它失败导致工具不可用。

  const host = new ToolHost(ctx)
  const registry = store ? buildRegistry(store, host) : null
  host.definitions = registry
    ? new Map([...registry.entries()].map(([toolName, item]) => [toolName, item.definition]))
    : new Map()

  try {
    ctx.effect(() => {
      const disposers = []

      // 常驻：目录 + 注入 + 单次调用（三者都刻意保持极短）
      const resident = store
        ? ['mem_admin_catalog', 'mem_admin_open', 'mem_admin_call']
        : []
      for (const toolName of resident) {
        try {
          disposers.push(ctx.tools.register(registry.get(toolName).definition))
        } catch (error) {
          diag('register failed ' + toolName + ': ' + (error?.message ?? String(error)))
        }
      }
      if (!store) {
        try {
          disposers.push(ctx.tools.register(degradedCatalog(openError, dataDir)))
        } catch (error) {
          diag('degraded catalog failed: ' + (error?.message ?? String(error)))
        }
      }

      return () => {
        host.closeAll()
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 忽略 */
          }
        }
        try {
          store?.close()
        } catch {
          /* 忽略 */
        }
      }
    }, 'memory-core.tools')
    diag('tools registered')
  } catch (error) {
    diag('tools effect FAILED: ' + (error?.message ?? String(error)))
  }

  // P6 服务化已拆到独立插件行 lib/service-plugin.js：
  // 主插件不再调用 ctx.provide —— 那一步一旦抛错会把整个插件带崩。

  if (store) {
    try {
      ctx.systemPrompt?.section?.({
        name: 'memory-core',
        order: 58,
        text: [
          '# 六层记忆底座（memory-core）',
          '- 默认只常驻 mem_admin_catalog；要用检索/写入，先 mem_admin_open 注入 mem_search / mem_write / mem_read。',
          '- 检索无命中就是空，不要编造"没有找到相关记忆"这类话术；写入前不要替用户润色事实。',
          '- S 级（凭证类）记录默认不进检索结果，需要时显式 include_sensitive=true 并说明理由。',
        ].join('\n'),
      })
    } catch {
      /* systemPrompt 可选，缺失不影响工具 */
    }

    // P1：动态记忆快照。每次组装系统提示词时调用，取指针、按预算截断、无内容即空。
    // 用 context 而不是 section：它是"模型可见的数据快照"，不是指令。
    if (injector) {
      try {
        ctx.effect(() => {
          const dispose = ctx.systemPrompt?.context?.({
            name: 'memory-core',
            order: 60,
            text: () => injector.text(),
          })
          return () => {
            try {
              dispose?.()
            } catch {
              /* 忽略 */
            }
          }
        }, 'memory-core.context')
      } catch {
        /* systemPrompt.context 不可用时静默降级：只保留工具 */
      }
    }

    // P7：每轮记忆生命周期 —— 自动召回（agent/pre-step）+ 候选沉淀（turn/end → pending）。
    // 这一层让记忆不再依赖"模型想得起来调 mem_search"。
    if (store) {
      try {
        ctx.effect(() => {
          const dispose = attachLifecycle(ctx, {
            store,
            config: config.lifecycle ?? {},
            diag,
          })
          return () => {
            try {
              dispose?.()
            } catch {
              /* 忽略 */
            }
          }
        }, 'memory-core.lifecycle')
      } catch (error) {
        diag('lifecycle: attach failed: ' + (error?.message ?? String(error)))
      }
    }

    // P4：设置页「记忆底座」的 RPC 通道。UI 只读 + 审核，不直接读库。
    // 宿主里 connection 服务可能在 apply 时还没就绪；这里延迟重试，
    // 并把探测结果写进 docs/_rpc-diag.log，避免靠猜。
    ctx.effect(() => {
      const diagFile = path.join(HERE, '..', 'docs', '_rpc-diag.log')
      const diag = (msg) => {
        try {
          fs.appendFileSync(diagFile, `${new Date().toISOString()} ${msg}\n`, 'utf8')
        } catch {
          /* 诊断写失败不影响主流程 */
        }
      }
      try {
        diag('apply: connection=' + Boolean(ctx.get?.('connection')) + ' webServer=' + Boolean(ctx.get?.('webServer')))
      } catch (e) {
        diag('probe failed: ' + (e?.message ?? String(e)))
      }

      const parseHits = (raw) => {
        try {
          const v = JSON.parse(raw || '[]')
          return Array.isArray(v) ? v : []
        } catch {
          return []
        }
      }
      const recentTraces = (limit) => {
        if (!store) return []
        const n = Math.min(Math.max(Number(limit) || 20, 1), 200)
        return store.db
          .prepare('SELECT trace_id, at, op, query_preview, hits FROM traces ORDER BY at DESC LIMIT ?')
          .all(n)
          .map((t) => ({ ...t, hits: parseHits(t.hits) }))
      }

      const handler = async (endpoint, payload) => {
        const args = payload || {}
        try {
          if (!store) {
            return { ok: false, error: { code: 'memory/degraded', message: openError?.message ?? '记忆库不可用' } }
          }
          if (endpoint === 'status') {
            const s = store.stats()
            return { ok: true, value: { ...s, lifecycle: lifecycleSummary(), qq: qq ? qq.status() : null, qqOfficial: qqOfficial ? qqOfficial.status() : null, recent: recentTraces(5) } }
          }
          if (endpoint === 'search') {
            return { ok: true, value: decorateRows(store.search({ query: String(args.query ?? ''), topK: args.topK })) }
          }
          if (endpoint === 'read') {
            return {
              ok: true,
              value: readDetail({
                store,
                recordId: String(args.record_id ?? ''),
                includeSensitive: Boolean(args.includeSensitive),
              }),
            }
          }
          if (endpoint === 'pending') return { ok: true, value: decorateRows(store.pendingReview(args.limit)) }
          if (endpoint === 'handoffs') return { ok: true, value: store.handoffList() }
          if (endpoint === 'handoff') return { ok: true, value: store.handoffRead(String(args.scene ?? '')) }
          if (endpoint === 'check') return { ok: true, value: store.checkBudgets(args.scene ?? null) }
          if (endpoint === 'tasks') {
            return { ok: true, value: store.taskList({ scene: args.scene ?? null, scope: args.scope ?? 'all' }) }
          }
          if (endpoint === 'task') return { ok: true, value: store.taskGet(String(args.task_id ?? '')) }
          if (endpoint === 'review') {
            return { ok: true, value: store.review(String(args.record_id ?? ''), String(args.decision ?? ''), args.note ?? null) }
          }
          if (endpoint === 'traces') return { ok: true, value: recentTraces(args.limit) }
          if (endpoint === 'parts') return { ok: true, value: listParts() }
          if (endpoint === 'graph/view') {
            const id = String(args.record_id ?? '')
            if (!id) return { ok: false, error: { message: 'record_id 必填' } }
            if (store.db.prepare('SELECT COUNT(*) AS n FROM edges').get().n === 0) store.buildEdges()
            return { ok: true, value: store.graphNeighbors(id, { hops: args.hops ?? 1, edgeTypes: args.edge_types ?? null }) }
          }
          if (endpoint === 'records') {
            const layer = String(args.layer ?? '')
            const limit = Math.min(Math.max(Number(args.limit ?? 200), 1), 500)
            const rows = layer
              ? store.db.prepare("SELECT record_id, layer, sad_level, summary, created_at FROM records WHERE status = 'active' AND layer = ? ORDER BY created_at DESC LIMIT ?").all(layer, limit)
              : store.db.prepare("SELECT record_id, layer, sad_level, summary, created_at FROM records WHERE status = 'active' ORDER BY created_at DESC LIMIT ?").all(limit)
            return { ok: true, value: decorateRows(rows) }
          }
          if (endpoint === 'graph.all') {
            if (store.db.prepare('SELECT COUNT(*) AS n FROM edges').get().n === 0) store.buildEdges()
            const nodes = store.db.prepare("SELECT record_id, layer, sad_level, summary, created_at FROM records WHERE status = 'active' LIMIT 300").all()
            const edges = store.db.prepare('SELECT from_id, to_id, kind FROM edges LIMIT 3000').all()
            return { ok: true, value: { nodes: decorateRows(nodes), edges } }
          }
          if (endpoint === 'timeline') {
            const data = timeline({ store, days: args.days ?? 7 })
            const groups = (data?.groups ?? []).map((g) => ({ ...g, memories: decorateRows(g.memories) }))
            return { ok: true, value: { ...data, groups } }
          }
          if (endpoint === 'affect/report') return { ok: true, value: affectReport({ store, range: args.range ?? 'day' }) }
          if (endpoint === 'affect/ingest') return { ok: true, value: ingestQqSessions({ store, limit: args.limit ?? 20 }) }
          if (endpoint === 'parts/meta') return { ok: true, value: catalogMeta() }
          if (endpoint === 'parts/library') return { ok: true, value: searchLibrary(args) }
          if (endpoint === 'parts/installed') {
            const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
            const profile = String(config.profile ?? process.env.DSH_PROFILE ?? 'desktop')
            return { ok: true, value: listInstalled({ dshHome, profile }) }
          }
          if (endpoint === 'parts/install') {
            if (config.parts?.allowInstall === false) return { ok: false, error: { code: 'memory/forbidden', message: '安装已禁用（config.parts.allowInstall=false）' } }
            const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
            const profile = String(config.profile ?? process.env.DSH_PROFILE ?? 'desktop')
            const job = startJob(async (progress, setAbort) => {
              try { return await installPart({ item: args.item, profile, dshHome, onProgress: progress, registerAbort: setAbort }) }
              finally { resetActive() }
            })
            return { ok: true, value: { jobId: job.id } }
          }
          if (endpoint === 'parts/uninstall') {
            if (config.parts?.allowInstall === false) return { ok: false, error: { code: 'memory/forbidden', message: '卸载已禁用（config.parts.allowInstall=false）' } }
            const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
            const profile = String(config.profile ?? process.env.DSH_PROFILE ?? 'desktop')
            const job = startJob(async (progress, setAbort) => {
              try { return await uninstallPart({ name: args.name, profile, dshHome, onProgress: progress, registerAbort: setAbort }) }
              finally { resetActive() }
            })
            return { ok: true, value: { jobId: job.id } }
          }
          if (endpoint === 'parts/job') return { ok: true, value: getJob(args.jobId) }
          if (endpoint === 'parts/job/cancel') return { ok: true, value: cancelJob(args.jobId) }
          if (endpoint === 'observe') {
            // 观测层：近 24h 的注入/召回活动 + 库健康，供面板和 dsh-context 对照
            const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
            const injectRows = store.db
              .prepare("SELECT injected FROM traces WHERE op = 'inject' AND at >= ?")
              .all(since)
            let pointers = 0
            for (const r of injectRows) {
              try {
                const a = JSON.parse(r.injected || '[]')
                if (Array.isArray(a)) pointers += a.length
              } catch {
                /* 忽略坏行 */
              }
            }
            const searchRows = store.db
              .prepare("SELECT hits FROM traces WHERE op = 'search' AND at >= ?")
              .all(since)
            let hits = 0
            for (const r of searchRows) {
              try {
                if (JSON.parse(r.hits || '[]').length > 0) hits += 1
              } catch {
                /* 忽略坏行 */
              }
            }
            // 近 14 天情绪趋势：每天写入量 + 负面/正面条数（缺的日期补 0）
            const trendDays = 14
            const trendSince = new Date(Date.now() - (trendDays - 1) * 24 * 3600 * 1000).toISOString().slice(0, 10)
            const rawTrend = store.db
              .prepare(
                `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
                        SUM(CASE WHEN affect_label IN ('negative', 'urgent') THEN 1 ELSE 0 END) AS bad,
                        SUM(CASE WHEN affect_label = 'positive' THEN 1 ELSE 0 END) AS good
                   FROM records
                  WHERE status = 'active' AND substr(created_at, 1, 10) >= ?
                  GROUP BY day`,
              )
              .all(trendSince)
            const byDay = new Map(rawTrend.map((r) => [r.day, r]))
            const trend = []
            for (let i = trendDays - 1; i >= 0; i -= 1) {
              const day = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10)
              const row = byDay.get(day)
              trend.push({ day, n: row?.n ?? 0, bad: row?.bad ?? 0, good: row?.good ?? 0 })
            }
            return {
              ok: true,
              value: {
                windowHours: 24,
                injectCount: injectRows.length,
                avgPointers: injectRows.length ? Math.round((pointers / injectRows.length) * 10) / 10 : 0,
                searchCount: searchRows.length,
                hitCount: hits,
                affect: Object.fromEntries(
                  store.db
                    .prepare(
                      "SELECT COALESCE(affect_label, 'neutral') AS label, COUNT(*) AS n FROM records WHERE status = 'active' GROUP BY label",
                    )
                    .all()
                    .map((r) => [r.label, r.n]),
                ),
                trend,
                stats: store.stats(),
              },
            }
          }
          return { ok: false, error: { code: 'memory/unknown-endpoint', message: 'unknown endpoint: ' + String(endpoint) } }
        } catch (error) {
          return { ok: false, error: { code: 'memory/error', message: error?.message ?? String(error) } }
        }
      }

      let dispose = null
      let timer = null
      let tries = 0

      // 退路：桌面宿主没有 connection 服务（它属于 dsh web），
      // 但 webServer.register 一定在。这里手工实现同一条 RPC 信封协议。
      const registerRaw = () => {
        const webServer = ctx.get?.('webServer')
        if (!webServer || typeof webServer.register !== 'function') {
          diag('webServer 也不可用')
          return false
        }
        const wantPath = '/memory-core'
        try {
          dispose = webServer.register({
            kind: 'prefix',
            path: wantPath,
            handler: async (req, res) => {
              try {
                const pathname = new URL(req.url, 'http://127.0.0.1').pathname
                const endpoint = pathname.slice(wantPath.length + 1)
                if (req.method !== 'POST' || !endpoint) {
                  res.statusCode = 404
                  res.end('not found')
                  return
                }
                // 原始路由不走 connection 的 Host/Origin 围栏，这里补一个最小同源校验
                const origin = req.headers.origin
                if (origin) {
                  try {
                    if (new URL(origin).host !== req.headers.host) {
                      res.statusCode = 403
                      res.end('forbidden')
                      return
                    }
                  } catch {
                    res.statusCode = 403
                    res.end('forbidden')
                    return
                  }
                }
                let body = ''
                for await (const chunk of req) body += chunk
                // 对外 HTTP API（token 鉴权），不走 RPC 信封
                if (apiHandler && endpoint.startsWith('api/')) {
                  let parsed = {}
                  try {
                    parsed = body ? JSON.parse(body) : {}
                  } catch {
                    parsed = {}
                  }
                  const apiResult = await apiHandler({
                    path: endpoint.slice(4),
                    method: req.method ?? 'POST',
                    headers: req.headers ?? {},
                    body: parsed,
                  })
                  res.statusCode = apiResult.status
                  res.setHeader('content-type', 'application/json; charset=utf-8')
                  res.end(JSON.stringify(apiResult.json))
                  return
                }
                const msg = JSON.parse(body || '{}')
                const result = await handler(endpoint, msg.payload || {})
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ type: 'server-response', rpcId: msg.rpcId ?? 'unknown', result }))
              } catch (error) {
                res.statusCode = 400
                res.end(String(error?.message ?? error))
              }
            },
          })
          diag('registered raw prefix route via webServer: ' + wantPath)
          return true
        } catch (error) {
          diag('raw register failed: ' + (error?.message ?? String(error)))
          return false
        }
      }

      const attempt = () => {
        if (dispose) return
        tries += 1
        const connection = ctx.get?.('connection')
        if (connection && connection.rpc && typeof connection.rpc.handle === 'function') {
          try {
            dispose = connection.rpc.handle('/memory-core', handler)
            diag('registered via connection（第 ' + tries + ' 次尝试）')
            return
          } catch (error) {
            diag('connection register failed: ' + (error?.message ?? String(error)))
          }
        } else if (tries === 1) {
          diag('connection 不可用，改走 webServer 原始路由')
        }
        if (tries <= 3 && registerRaw()) return
        if (tries < 30) timer = setTimeout(attempt, 1000)
        else diag('give up: connection 与 webServer 都不可用')
      }
      attempt()

      return () => {
        if (timer) clearTimeout(timer)
        try {
          dispose?.()
        } catch {
          /* 忽略 */
        }
      }
    }, 'memory-core.rpc')
  }
}
