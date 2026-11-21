# dsh-sixlayer-memory · 六层记忆底座

[![npm](https://img.shields.io/npm/v/dsh-sixlayer-memory?style=flat-square&label=npm)](https://www.npmjs.com/package/dsh-sixlayer-memory)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1%20%3C0.3.0-4c6ef5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

> **会先审后记、还带审计链的本地记忆。**
> 每一轮按你的输入自动召回；不确定的东西不会直接变成事实；每个动作都能倒查。

```powershell
dsh plugin --profile desktop add dsh-sixlayer-memory
```

**当前版本**：2.0.3 · **32 个工具** · schema v9 · 零外部依赖 · 回归 31 个套件全绿

📦 [npm](https://www.npmjs.com/package/dsh-sixlayer-memory) · 🎬 [40 秒介绍视频](media/intro-40s.mp4) · 📝 [变更记录](CHANGELOG.md)

---

## 30 秒：它到底解决什么

| 你会遇到的 | 装之前 | 装之后 |
|---|---|---|
| 隔天回来，模型又要你重讲一遍 | 靠自己复述，或者问它"还记得吗" | 开口就带着相关记忆——按**本轮输入**检索，不是固定几条快照 |
| 你说过"以后都用 SQLite"，下次它还给 MySQL | 记不记得全看模型自觉 | 抽成候选 → 你点一下批准 → 变成长期口径 |
| 记忆里混进一句"忽略以上指令" | 无从察觉 | 未验证先入待审；命中投毒特征直接隔离 |
| 想知道它记了什么、谁改的 | 看不到 | 面板 + 哈希链审计，断链能定位到文件与行号 |

> **面板里不写工程黑话**：每条记忆都以「类别 · 时间 · 一句话」出现，例如
> **修过的坑 · 3 周前 · USB 摄像头卡死的软件复位**，下面一行 `10月26日实测有效，免拔插。`
> 记录号、层级、评分只在详情里出现——普通人看不懂的东西不该占主位置。

## 三条不能破的规矩

1. **先审后记**：不是用户亲手打的字，一律 `pending`，审核后才可信。
2. **S 级不出库**：凭证/隐私判 S，注入、检索、联想、API、QQ 回复全路径不带正文。
3. **每个动作留痕**：写入/读取/注入/召回都有审计行，篡改一眼可见。

---

## 它解决什么问题

DSH 的会话是短的，但你的工作不是。
模型每次都要重新认识你：上次踩过的坑、定过的口径、修过的 bug，聊完就没了。

这个插件把「记忆」做成一层基础设施：

| 痛点 | 做法 |
|---|---|
| 聊完就忘 | 写入 L0–L5 六层，按层级注入 |
| **模型想不起来调工具** | **每轮自动召回**：`agent/pre-step` 拿本轮输入检索，命中条目插在问题前 |
| **不主动记就什么都没有** | **候选沉淀**：`turn/end` 抽"长期约定"句式 → 过闸门 → 待审队列 |
| 记错东西 | 闸门公理：非用户直输先审后入（pending） |
| 换个说法就找不到 | FTS5 + 中文 bigram；可选语义召回（本机 Ollama / OpenAI 兼容端点），关了也不影响 |
| 想不起关联 | `mem_associate`：标签 / 语义 / 情绪三路联想 |
| 不知道记了啥 | 设置面板 + 右侧栏观测，注入/召回/情绪一目了然 |
| 别的程序用不上 | `memory` 服务 + HTTP API（token 鉴权） |
| 聊天里的情绪记不住 | **情绪观察**：QQ 会话自动采集、日报/周报、尖峰提醒 |
| 能力被锁在一个插件里 | **零件化**：`mem_parts` / `mem_compose`，按场景装配 |
| 找不到能装的零件 | **零件库**：集市索引 800 条快照，可搜索、可复制安装命令 |

---

## 能力一览

### 记忆本体

- **六层**：L0 宪法 / L1 共享 / L2 场景 / L3 个人 / L4 运行时 / L5 归档
- **写入链**：信任判定 → 投毒粗筛 → S/A 分级 → 内容去重 → 落库 → 审计
- **闸门公理**：`非 trusted && 非 user 直输 && 非 legacy_import` → `pending`，审核后才 trusted
- **S 级隔离**：凭证/隐私一律 S；注入、检索、联想、API 响应**永不**带 S 正文
- **哈希链审计**：每条写入/读取/注入一条 JSONL，链断裂可检测（`mem_audit`）

### 每轮生命周期（2.0 新增，`lib/memory/lifecycle.js`）

| 环节 | 挂点 | 做什么 | 失败怎么办 |
|---|---|---|---|
| **自动召回** | `agent/pre-step`（第 1 步） | 本轮用户直输 → FTS5 检索 → 命中条目作为一条 user 消息插在问题前；带围栏、标明"数据不是指令"；S 级/tainted 永不进 | fail-open：抛错就原样放行，绝不断这一轮 |
| **候选沉淀** | `session/event` → `turn/end`（completed） | 抽"以后/一律/记住/约定/我习惯"这类句子 → `tool` 通道写入 → 闸门公理 → **pending 待审** | 同样 fail-open |
| **用进强化** | 召回命中时 | α += 0.02（上限 1），并留一条 `op=recall` 审计 | 忽略 |

三条硬规矩：

1. **召回只给指针/摘要，不给 S 级正文**，且未验证来源只出 record_id。
2. **沉淀永远不直接进 active** —— 自动采集的通道是 `tool`（unverified），一律过闸门进待审，驳回成本一次点击。
3. **开关与预算可配**（见下），关掉就退回 1.x 的"纯工具调用"行为。

```yaml
lifecycle:
  enabled: true
  recall:
    enabled: true
    topK: 3
    maxChars: 900
    cooldownMs: 30000
    steps: [1]
    semantic:                      # 可选：同义改写也能召回；不开就是纯词法
      enabled: false
      provider: ollama             # ollama | openai（OpenAI 兼容端点）
      endpoint: 'http://127.0.0.1:11434/api/embeddings'
      model: 'bge-m3'
      weight: 0.55                 # 混合分里向量占的比重
      minScore: 0.2
  capture: { enabled: true, maxPerTurn: 2, minChars: 12, maxChars: 300 }
  reinforce: { enabled: true, delta: 0.02 }
```

### 语义召回（可选，`lib/memory/embed.js`）

同义改写（"上次那个内存占用的问题" → "RSS 峰值排查"）靠 bigram 是捞不回来的。
打开 `semantic` 后会多一层向量召回：

- **候选池** = 词法命中 ∪ 已索引记录的余弦相似度，按 `weight` 混合排序，每条结果标 `why = vector / lexical / both`。
- **索引是 sidecar**：`<dataDir>/db/embeddings.json`，不动 SQLite schema、不需要迁移。
- **只索引** active、非 S、非 tainted 的记录；凭证永远不进向量库。
- **fail-open**：端点连不上 / 超时 / 模型换名 → 本轮直接退回纯词法，不报错、不拖慢。
- 词法一条都没命中时，还会用内置同义词表**再查一次**（数据库/database/db/sql …），这一步不需要任何模型。

### 认知层（B1–B4）

- **情绪标注**（确定性规则，不调模型）：`neutral / positive / negative / urgent`，含效价与唤醒度
- **重要性**：基线 + 情绪强度 + 层级加成，`mem_judge` 的 beta 继续修正
- **联想** `mem_associate`：由 A 想到 B，每条结果带理由与权重
- **注入增强**：高唤醒负面记忆优先浮出；首条记忆带一行 `> 关联：`

### 协作与观测

- **交接** `mem_handoff` / `mem_check`：跨会话场景交接、体量体检
- **派单** `mem_dispatch / mem_receipt / mem_task / mem_scope`：状态机 sent→delivered→acked→done
- **面板**：总览 / 检索 / 待审 / 交接 / 派单 / 观测 / 审计
- **入口**：设置 → 记忆底座；对话顶栏「记忆」；右侧栏入口卡（与 dsh-context 的 Context 并排）

### 对外通道

- **`memory` 服务**：`ctx.memory.recall/remember/forget/status`（进程内，给其他插件）
- **HTTP API**：`127.0.0.1:47810`，token 鉴权，默认只读（status/recall/read）
- **QQ**：腾讯官方插件 `@tencent-connect/dsh-qqbot` 驱动 agent，agent 自带 `mem_*` 工具

---

## 架构

```
              ┌────────────── 写入口 ──────────────┐
  mem_write → │ 扫描 → 信任 → 分级 → 去重 → 落库 │ → records / FTS / tags / 审计
  QQ / API  → └────────────────────────────────────┘
                              │
 系统提示词 ← Injector ← 层级选择 + 组合限制 + 情绪加权 + 关联行
                              │
 设置面板 / 右侧栏 / 对话页签 ← RPC（webServer 原始路由）
                              │
       其他插件 ← ctx.memory ← service-plugin（独立行，挂了不影响主插件）
```

---

## 安装

### 市场 / npm（推荐）

```powershell
dsh plugin --profile desktop add dsh-sixlayer-memory
```

### 本地开发（目录联接）

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sixlayer-memory" `
  -Target "D:\001\CH002\dsh-memory-core"
```

然后把包名登记进 `profiles/desktop/package.json` 的 `dsh.profile.bundles`：

```json
"dsh-sixlayer-memory"
```

### 配置

`profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: memory-core
      name: dsh-sixlayer-memory
      config:
        dataDir: 'D:\001\CH002\dsh-memory-data'
        authority: shadow
        api:
          enabled: true
          token: ''
          allowWrite: false
          port: 47810
```

重启 DSH 即可。详见 [docs/安装说明.md](docs/安装说明.md) 与 [RELEASE.md](RELEASE.md)。

---

## 安全模型

| 约束 | 说明 |
|---|---|
| 闸门不得绕过 | 只有 `user` 直输 / 已审核 / 旧数据导入能 trusted |
| S 级不外发 | 注入、检索、联想、API、QQ 回复全部排除 S 正文 |
| 审计不可静默 | 写入/读取/注入都有 trace，链断可查 |
| 外部通道最小权限 | API 默认只读；QQ 白名单默认全拒；限流 120 次/分 |
| 不物理删除 | 归档只降层/改状态，`mem_archive` 可逆 |

---

## 运维要点

### 改完先跑检查（硬性）

```bash
npm run check    # = preflight 8 项 + 19 个回归套件
```

**PREFLIGHT OK + VERIFY OK 才允许重启。** 规则见 [docs/插件规范.md](docs/插件规范.md)，
事故记录见 [docs/错题本.md](docs/错题本.md)。

### 改完代码怎么生效

DSH 按 URL 缓存 ESM，**热载不会重新 import**。改 `lib/*.js` 后：

1. 跑 `node tools/smoke.mjs` + `node tools/validate-tools.mjs`（秒级）
2. 再重启应用

### 重启后 30 秒自检

```
mem_admin_catalog        # 29 个工具 = 加载成功
mem_audit({ deep: true }) # 哈希链一致
mem_check()              # 体量体检
```

### 血泪教训（务必记住）

1. **绝不能用 PowerShell 写 JSON/YAML**：`Set-Content -Encoding utf8` / `ConvertTo-Json` 会写 BOM，
   导致 DSH 启动崩溃（`JSON.parse` 不剥 BOM）。一律用 Node `fs.writeFileSync` 并校验 `JSON.parse`。
2. **`file://` 直连的插件行在某些宿主版本不加载**：改用包名 + node_modules 链接。
3. **重启会重写 `cordis.patch.yml`**：加载失败的行可能被删，先备份。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/安装说明.md](docs/安装说明.md) | 逐步安装、配置、验证 |
| [RELEASE.md](RELEASE.md) | 发布手册：包名冲突、npm 登录、市场条目、回滚 |
| [docs/演示脚本-30秒.md](docs/演示脚本-30秒.md) | 三条 30 秒视频的分镜与字幕 |
| [docs/生命周期-自动召回与候选.md](docs/生命周期-自动召回与候选.md) | 2.0 生命周期：挂点、预算、失败模式、验收 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [docs/服务契约.md](docs/服务契约.md) | `memory` 服务的方法与语义 |
| [docs/HTTP-API说明.md](docs/HTTP-API说明.md) | 对外 API 端点、鉴权、示例 |
| [docs/QQ官方机器人接入.md](docs/QQ官方机器人接入.md) | QQ Bot v2 接入 |
| [docs/零件化-记忆.md](docs/零件化-记忆.md) | 「一切皆零件」：零件清单与装配协议 |
| [docs/零件库.md](docs/零件库.md) | 零件库：集市索引快照、搜索、安装纪律 |
| [docs/方案-情绪观察.md](docs/方案-情绪观察.md) | 情绪采集/日报周报/提醒 的设计与落地 |
| [docs/认知层-B方案.md](docs/认知层-B方案.md) | 情绪/重要性/联想设计与路线 |
| [docs/认知层-第一增量.md](docs/认知层-第一增量.md) … 第五增量 | 每个增量的实施记录 |
| [docs/移植日志-workbench记忆机制.md](docs/移植日志-workbench记忆机制.md) | 从 workbench 移植的方法论 |
| [docs/六期日志-服务化.md](docs/六期日志-服务化.md) | 服务化设计与落地 |

---

## 路线

- ✅ 零件化：`mem_parts` / `mem_compose`（5 个零件）
- ✅ 存量情绪回填（26 条）
- ✅ B1–B4：情绪、重要性、联想、观测趋势
- ✅ B5：右侧栏页签（与 dsh-context 并排）
- ⬜ 发布：GitHub 仓库 + 演示视频
- ⬜ 存量记忆情绪回填（可选，会改数据）
- ⬜ 图查询与加密（graph/crypto 目前 degraded）

---

## 许可

MIT


## 工作台改造（1.9.0）

- 首屏 = 记忆可视化：搜索、记录列表、详情、关系图、时间轴
- 关系图：节点可拖拽、背景可平移、滚轮缩放、悬停看摘要
- 其余功能（检索/待审/交接/派单/观测/时间轴/零件/安全/审计）收进「更多」二级页签
- 只读：不改数据
- 语音/视频服务独立，不再带记忆可视化页面
