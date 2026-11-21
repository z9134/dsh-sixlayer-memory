/**
 * service.js — 记忆底座对外服务（P6 服务化）。
 *
 * 设计口径（docs/方案-服务化.md）：
 *  - 只暴露窄契约：recall / remember / forget / status；
 *  - recall 只给指针，不给正文；S 级永不返回；未验证来源不给摘要；
 *  - remember 走完整写入链，不绕过闸门；
 *  - forget 只降层/归档，永不物理删除；
 *  - 库不可用时返回 { degraded: true }，不抛异常。
 *
 * 这个文件不依赖 Cordis：传入 store 就能跑，便于单测。
 */
import { nowIso } from './util.js'
import { listParts, compose as composePack } from '../parts/index.js'

export const SERVICE_API_VERSION = 1

const POINTER_FIELDS = ['record_id', 'layer', 'sad_level', 'created_at']

/**
 * @param {{store: any, injector?: any}} options
 */
export function buildService({ store = null, injector = null } = {}) {
  const degraded = (reason) => ({ pointers: [], degraded: true, reason: String(reason ?? 'store unavailable') })

  return {
    apiVersion: SERVICE_API_VERSION,

    /** 召回：只给指针。 */
    recall({ query = '', principal = null, scope = 'personal', topK = 5 } = {}) {
      if (!store) return degraded('记忆库不可用')
      if (scope === 'group') {
        // v1 没有群共享层：群聊一律拿不到个人记忆（策略矩阵的硬要求）
        return { pointers: [], note: 'v1 暂无群共享层，群聊不返回个人记忆' }
      }
      try {
        const rows = store.search({ query: String(query ?? ''), topK, principalId: principal })
        const pointers = rows.map((r) => {
          const ptr = {}
          for (const k of POINTER_FIELDS) ptr[k] = r[k]
          // 未验证来源只给 id，不给摘要（公理 3）
          if (r.trust_level !== 'unverified') ptr.summary = r.snippet
          return ptr
        })
        return { pointers }
      } catch (error) {
        return degraded(error?.message ?? String(error))
      }
    },

    /** 写入：走完整写入链（信任判定 → 扫描 → 分级 → 去重 → 闸门）。 */
    remember({ content, source = 'plugin', principal = null, projectId = null, tags = [] } = {}) {
      if (!store) return { degraded: true, reason: '记忆库不可用' }
      const result = store.write({
        content,
        layer: 'L2',
        sourceChannel: source,
        origin: 'manual',
        principalId: principal,
        projectId,
        tags: Array.isArray(tags) ? tags : [],
      })
      return {
        record_id: result.record_id,
        status: result.status,
        trust_level: result.trust_level,
        sad_level: result.sad_level,
        dedup: Boolean(result.dedup),
        skipped: Boolean(result.skipped),
      }
    },

    /** 遗忘：只降层或归档，永不物理删除。 */
    forget({ record_id, mode = 'archive' } = {}) {
      if (!store) return { degraded: true, reason: '记忆库不可用' }
      const id = String(record_id ?? '')
      if (!id) throw new Error('memory.forget: 需要 record_id')
      const row = store.db.prepare('SELECT record_id, status, depth FROM records WHERE record_id = ?').get(id)
      if (!row) throw new Error('memory.forget: 没有记录 ' + id)
      const now = nowIso()
      if (mode === 'downgrade') {
        store.db.prepare('UPDATE records SET depth = depth + 1, updated_at = ? WHERE record_id = ?').run(now, id)
        return { record_id: id, status: 'downgraded', depth: row.depth + 1 }
      }
      store.db.prepare("UPDATE records SET status = 'archived', updated_at = ? WHERE record_id = ?").run(now, id)
      return { record_id: id, status: 'archived' }
    },

    /** 健康摘要（给面板/监控）。 */
    status() {
      if (!store) return { degraded: true, reason: '记忆库不可用' }
      try {
        const s = store.stats()
        return {
          records: s.records,
          active: s.active,
          pending: s.pending,
          sLevel: s.sLevel,
          audit: s.audit,
          schemaVersion: s.schemaVersion,
          authority: s.authority,
        }
      } catch (error) {
        return { degraded: true, reason: error?.message ?? String(error) }
      }
    },

    /** 零件清单（理念：一切皆零件——记忆能力是可命名、可替换的小零件）。 */
    parts() {
      return listParts()
    },

    /** 按零件装配上下文包：给场景 + 零件列表，拼出可直接使用的记忆包。 */
    compose({ scene = '', parts = null, seed = null, maxChars = 1200 } = {}) {
      if (!store) return { degraded: true, reason: '记忆库不可用', text: '' }
      try {
        return composePack(store, { scene, parts, seed, maxChars })
      } catch (error) {
        return { degraded: true, reason: error?.message ?? String(error), text: '' }
      }
    },
  }
}
