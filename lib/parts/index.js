/**
 * parts.js — 把记忆能力拆成「零件」，并提供装配协议。
 *
 * 理念来源：DSH「一切皆零件」——功能不写死成一个大黑盒，
 * 而是拆成有名字、有契约、可替换的小零件，按需拼装。
 *
 * 零件契约：
 *   { name, version, describe(), run(store, ctx) -> string[] }
 *
 * 装配：compose(store, { scene, parts, maxChars })
 *   - 按给定顺序执行零件
 *   - 去重、限长、保留来源标注
 */

function oneLine(text, max = 100) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function rowsToLines(rows) {
  return rows.map((r) => `- [${r.layer}/${r.affect_label ?? 'A'}] ${oneLine(r.summary)}`)
}

export const PARTS = {
  profile: {
    version: 1,
    describe: '身份与长期事实：高重要性、L1/L2 的记忆',
    run(store, ctx = {}) {
      const rows = store.db
        .prepare(
          `SELECT layer, summary, affect_label FROM records
            WHERE status = 'active' AND sad_level != 'S' AND layer IN ('L1','L2')
            ORDER BY importance DESC, created_at DESC LIMIT ?`,
        )
        .all(Math.min(Number(ctx.limit ?? 3), 10))
      return rowsToLines(rows)
    },
  },

  recent: {
    version: 1,
    describe: '最近写入的活跃记忆',
    run(store, ctx = {}) {
      const rows = store.db
        .prepare(
          `SELECT layer, summary, affect_label FROM records
            WHERE status = 'active' AND sad_level != 'S'
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.min(Number(ctx.limit ?? 3), 10))
      return rowsToLines(rows)
    },
  },

  lessons: {
    version: 1,
    describe: '教训：负面/紧急且高唤醒的记忆',
    run(store, ctx = {}) {
      const rows = store.db
        .prepare(
          `SELECT layer, summary, affect_label FROM records
            WHERE status = 'active' AND sad_level != 'S'
              AND affect_label IN ('negative','urgent')
            ORDER BY COALESCE(affect_arousal,0) DESC, importance DESC LIMIT ?`,
        )
        .all(Math.min(Number(ctx.limit ?? 3), 10))
      return rowsToLines(rows)
    },
  },

  scene: {
    version: 1,
    describe: '指定场景的记忆（按 tag = scene 匹配）',
    run(store, ctx = {}) {
      const scene = String(ctx.scene ?? '').trim()
      if (!scene) return []
      const rows = store.db
        .prepare(
          `SELECT r.layer, r.summary, r.affect_label FROM records r
             JOIN tags t ON t.record_id = r.record_id
            WHERE (t.tag = ? OR t.tag = 'scene:' || ?) AND r.status = 'active' AND r.sad_level != 'S'
            ORDER BY r.importance DESC LIMIT ?`,
        )
        .all(scene, scene, Math.min(Number(ctx.limit ?? 5), 20))
      return rowsToLines(rows)
    },
  },

  associations: {
    version: 1,
    describe: '联想：与 seed（record_id 或文本）相关的记忆',
    run(store, ctx = {}) {
      const seed = String(ctx.seed ?? '').trim()
      if (!seed) return []
      const result = store.associate({ recordId: seed, query: seed, topK: Math.min(Number(ctx.limit ?? 3), 10) })
      return result.items.map((it) => `- [${it.layer}] ${oneLine(it.summary)} ｜ ${it.reasons.join('、')}`)
    },
  },
}

export function listParts() {
  return Object.entries(PARTS).map(([name, part]) => ({
    name,
    version: part.version,
    describe: part.describe,
  }))
}

/**
 * 装配：按顺序跑零件，拼成一段可直接注入的上下文。
 * @returns {{scene: string, parts: Array<{name: string, version: number, lines: string[]}>, text: string}}
 */
export function compose(store, input = {}) {
  const names = Array.isArray(input.parts) && input.parts.length > 0
    ? input.parts.map(String)
    : ['profile', 'lessons', 'recent']
  const maxChars = Math.min(Math.max(Number(input.maxChars ?? 1200), 100), 4000)
  const scene = String(input.scene ?? '')
  const ctx = { scene, seed: input.seed, limit: input.limit }

  const used = new Set()
  const blocks = []
  let budget = maxChars
  for (const name of names) {
    const part = PARTS[name]
    if (!part) {
      blocks.push({ name, version: 0, lines: ['（未知零件，已跳过）'] })
      continue
    }
    let lines = []
    try {
      lines = part.run(store, ctx) ?? []
    } catch (error) {
      lines = ['（零件执行失败：' + (error?.message ?? String(error)) + '）']
    }
    const kept = []
    for (const line of lines) {
      const key = line.replace(/^- /, '').slice(0, 40)
      if (used.has(key)) continue
      if (budget - line.length - 1 < 0) break
      used.add(key)
      kept.push(line)
      budget -= line.length + 1
    }
    blocks.push({ name, version: part.version, lines: kept })
  }

  const text = blocks
    .filter((b) => b.lines.length > 0)
    .map((b) => `### ${b.name}（v${b.version}）\n${b.lines.join('\n')}`)
    .join('\n\n')

  return { scene, parts: blocks, text }
}
