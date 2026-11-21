/**
 * schema.js — 六层记忆库 DDL 与迁移（schema v3）。
 *
 * 分层口径来自 luanyujia-workbench《总纲》：
 *   L0 宪法 / L1 共享层 / L2 场景私有 / L3 个人层 / L4 运行时 / L5 归档
 * 本库只存 L1/L2/L3 的正文；L0 只存引用（版本号 + 哈希 + 指针），L4 只存能力实现标识，L5 是冷区。
 *
 * v1 → v2（W2）：
 *   - records.scan_result  存扫描命中（JSON），便于事后回看"当时为什么这么判"
 *   - records.identity_id  调用方身份派生标识（owner / agent / unknown），不存原始凭证
 *   - review_queue 增加 note 列
 *
 * v2 → v3（二期）：
 *   - records.legacy_ref / legacy_source  导入时保留"从哪来"的指针（不存正文）
 *   - traces  记录仪索引表（正文 JSONL 才是 append-only 真源，此表只做按 trace_id 查）
 *
 * v3 → v4（P1）：
 *   - records.batch_id  同一会话/同一批写入的标识，用于 L2 组合攻击判定
 *
 * v4 → v5（迁移自 luanyujia-workbench 记忆机制）：
 *   - handoffs  每个场景一份「§〇 交接」，覆盖写、≤4 KB、五小节
 *
 * v5 → v6（协作与派单机制）：
 *   - tasks  派单台账：状态机 sent→delivered→acked→done/failed，超时进 overdue
 */

export const SCHEMA_VERSION = 9

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  record_id      TEXT PRIMARY KEY,
  layer          TEXT NOT NULL,                 -- L0..L5
  depth          INTEGER NOT NULL DEFAULT 0,    -- 0 = 摘要层
  content        TEXT NOT NULL,
  summary        TEXT,
  content_hash   TEXT NOT NULL,
  sad_level      TEXT NOT NULL DEFAULT 'A',     -- S / A / D
  trust_level    TEXT NOT NULL DEFAULT 'unverified',
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  origin         TEXT NOT NULL DEFAULT 'manual',-- manual / legacy_import / shadow
  principal_id   TEXT,
  identity_id    TEXT,                          -- owner / agent / unknown（派生标识）
  project_id     TEXT,
  session_id     TEXT,
  alpha          REAL,
  beta           REAL,
  scored         INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',-- active / pending / quarantined / archived / rejected
  pending_review INTEGER NOT NULL DEFAULT 0,
  conflict_of    TEXT,
  scan_result    TEXT,                          -- JSON: {flags,injection,sensitive}
  legacy_ref     TEXT,                          -- 导入来源指针（如 memories.json#3），不存正文
  legacy_source  TEXT,                          -- 导入来源文件路径
  batch_id       TEXT,                          -- 同一会话/同一批写入（L2 组合判定）
  affect_label   TEXT,                          -- 情绪标签（neutral / positive / negative / urgent）
  affect_valence REAL,                          -- 效价 -1..1
  affect_arousal REAL,                          -- 唤醒度 0..1
  importance     REAL NOT NULL DEFAULT 0.5,     -- 综合重要性 0..1（情绪 + 访问 + 时效）
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_hash    ON records(content_hash);
CREATE INDEX IF NOT EXISTS idx_records_layer   ON records(layer, status);
CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_records_status  ON records(status, pending_review);

CREATE TABLE IF NOT EXISTS tags (
  record_id TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (record_id, tag)
);

-- 场景交接（来自 luanyujia-workbench 记忆机制）：
-- 每个场景一份，覆盖写；sections 是 JSON，五小节固定键；
-- 体量上限 4 KB 由写入端强制，bytes 存实际字节数供体检。
CREATE TABLE IF NOT EXISTS handoffs (
  scene      TEXT PRIMARY KEY,
  title      TEXT,
  sections   TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- 派单台账（协作/派单机制）：
-- 状态机 sent → delivered → acked → done / failed；超时由查询时判定为 overdue。
-- messages 用于执行「同一件事 ≤3 条消息」的上限。
CREATE TABLE IF NOT EXISTS tasks (
  task_id     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- dispatch | notice
  from_scene  TEXT NOT NULL,
  to_scene    TEXT NOT NULL,
  title       TEXT NOT NULL,
  phenomenon  TEXT,
  how_to      TEXT,
  how_verify  TEXT,
  need_reply  INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL,              -- sent | delivered | acked | done | failed | closed
  messages    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deadline_at TEXT,
  ack_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_to   ON tasks(to_scene, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from ON tasks(from_scene, status);

CREATE TABLE IF NOT EXISTS review_queue (
  record_id  TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision   TEXT,
  note       TEXT
);

-- 检索索引：正文按 bigram 分词后写入 body（见 tokenize.js）
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  record_id UNINDEXED,
  body,
  tokenize='unicode61'
);

-- 记录仪索引：JSONL 是 append-only 真源，这张表只为了按 trace_id 快速回放
CREATE TABLE IF NOT EXISTS traces (
  trace_id     TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  at           TEXT NOT NULL,
  op           TEXT NOT NULL,
  principal_id TEXT,
  query_hash   TEXT,
  query_preview TEXT,
  hits         TEXT,
  injected     TEXT,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  duration_ms  INTEGER,
  prev_hash    TEXT,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_at ON traces(at);
CREATE INDEX IF NOT EXISTS idx_traces_op ON traces(op, at);

CREATE TABLE IF NOT EXISTS affect_events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT,
  source       TEXT NOT NULL DEFAULT 'qq',
  occurred_at  TEXT NOT NULL,
  label        TEXT NOT NULL,
  valence      REAL,
  arousal      REAL,
  excerpt      TEXT,
  excerpt_hash TEXT,
  triggers     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_affect_events_time ON affect_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_affect_events_label ON affect_events(label, occurred_at);

CREATE TABLE IF NOT EXISTS edges (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id, kind);
`

/**
 * 逐版本升级语句。只在 meta.schema_version 小于代码版本时执行。
 * 每条都必须是幂等的（SQLite 的 ADD COLUMN 不幂等，所以先查 pragma）。
 */
export const MIGRATIONS = {
  9: [],
  8: [],
  7: [
    { table: 'records', column: 'affect_label', sql: 'ALTER TABLE records ADD COLUMN affect_label TEXT' },
    { table: 'records', column: 'affect_valence', sql: 'ALTER TABLE records ADD COLUMN affect_valence REAL' },
    { table: 'records', column: 'affect_arousal', sql: 'ALTER TABLE records ADD COLUMN affect_arousal REAL' },
    { table: 'records', column: 'importance', sql: 'ALTER TABLE records ADD COLUMN importance REAL NOT NULL DEFAULT 0.5' },
  ],
  6: [],
  5: [],
  4: [
    { table: 'records', column: 'batch_id', sql: 'ALTER TABLE records ADD COLUMN batch_id TEXT' },
  ],
  3: [
    { table: 'records', column: 'legacy_ref', sql: 'ALTER TABLE records ADD COLUMN legacy_ref TEXT' },
    { table: 'records', column: 'legacy_source', sql: 'ALTER TABLE records ADD COLUMN legacy_source TEXT' },
  ],
  2: [
    { table: 'records', column: 'scan_result', sql: 'ALTER TABLE records ADD COLUMN scan_result TEXT' },
    { table: 'records', column: 'identity_id', sql: 'ALTER TABLE records ADD COLUMN identity_id TEXT' },
    { table: 'review_queue', column: 'note', sql: 'ALTER TABLE review_queue ADD COLUMN note TEXT' },
  ],
}
