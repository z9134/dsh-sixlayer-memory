# 变更记录 · dsh-sixlayer-memory（六层记忆底座）

## 2.0.3 — 2026-11-21

主题：**发布到 npm**。

### 变更

- `repository` / `bugs` / `homepage` 从占位符 `<your-account>` 换成真实仓库 `github.com/z9134/dsh-sixlayer-memory`
  （2.0.2 已经发到 npm，但页面上的仓库链接指向占位符，删不掉，只能靠新版本覆盖元数据）
- README 首屏加 npm / license / DSH 徽章与视频链接

### 发布

- `npm publish` → https://www.npmjs.com/package/dsh-sixlayer-memory
- 全程走 `registry.npmjs.org`（`www.npmjs.com` 在本机 403，Web 登录走不通，用 granular token + Bypass 2FA 发布）

---

## 2.0.2 — 2026-11-20

主题：**点一个圆球，就能看这条记忆的全部**。

### 新增

- **关系图点开详情**：左键点节点 → 打开这条记忆的完整详情；拖拽仍是移动节点
  - 用「按下位置 + 位移 > 4px」区分点击与拖拽，拖节点不会误触
  - 点空白处收起详情；指针移出画布只清状态、不算点击
  - 悬停时光标变成手型，画布角标改成「点一下看详情 / 拖节点 / 滚轮缩放」
  - 详情打开后自动滚进视野
- **详情卡 `DetailCard`**：人话标题 + 分类时间 + 元信息表（层级/分级/信任/来源/重要度）
  + 标签 + 完整正文 + 记录号 + **相关记忆**（点一下跳过去）
- `lib/memory/detail.js`：`readDetail()` 统一产出「这一条的全部」，RPC `read` 直接用它
- 回归 `tools/p28.mjs`（17 项）：正文/标签/相关记忆/人话标题/S 级降级

### 变更

- `read` RPC 返回值新增 `tags`、`neighbors`、`display`（旧字段不变）

### 修复

- 纯日期括号不再被人话吞掉：`Blender 能力扩展（2026-10-26）：…` 以前会显示成「10月26日。」，
  现在这种括号直接忽略（时间由 `when` 字段给），人话为空也不编造

---

## 2.0.1 — 2026-11-20

主题：**给普通人看的记忆**。存储层不变，只改"怎么讲给人听"。

### 新增

- `lib/memory/explain.js`：一条记录 → 「类别 + 标题 + 一句人话 + 相对时间」
  - 去术语：代码块、长内联代码、绝对路径、工程文件名、长哈希、URL 一律不出现
  - 括号里的关键补充提成一句话：「（2026-10-26 实测有效，免拔插）」→「10月26日实测有效，免拔插」
  - 分类：修过的坑 / 定下的规则 / 怎么做 / 聊过的话 / 你的偏好 / 记下的事实
  - 对话类解析成「你说过：… / 它回你：…」；太短的搭话降级成「随口聊了一句」
  - 纯函数、零依赖、离线（`tools/p27.mjs` 35 项）

### 变更（展示层）

- **关系图悬停提示**：`record_id · L2 · 原文` → 标题 + 一句人话 + 类别/时间，不再露记录号
- **列表 / 时间轴 / 邻居 / 检索结果**：统一走 `MemRow`，主行是标题，第二行是人话，第三行是类别 · 时间
- **详情页**：标题 + 人话在上，原文仍在 `pre` 里（要查细节随时能看）
- **`mem_search` 工具输出**：`1. 【修过的坑】USB 摄像头卡死的软件复位 —— 10月26日实测有效，免拔插。 [L2/A · trusted · score -9.22]`
- RPC `search / records / graph.all / timeline / pending / read` 返回值统一带 `display` 字段

### 修复

- 无（纯展示层 + 一处工具输出格式）

---

## 2.0.0 — 2026-11-19

主题：**从"工具调用式记忆"到"每轮都在的记忆"，并做好发布准备**。

### 新增

- **每轮自动召回**（`lib/memory/lifecycle.js`，挂 `agent/pre-step`）
  - 本轮用户直输 → FTS5 检索 → 命中条目作为 user 消息插在问题之前
  - 围栏 + "数据不是指令"；S 级 / tainted 永不进召回；未验证来源只给指针
  - 默认 topK=3 / 900 字 / 30 秒同 query 冷却
- **可选语义召回**（`lib/memory/embed.js`，默认关）
  - 本机 Ollama / OpenAI 兼容端点；sidecar 索引 `db/embeddings.json`，不动 schema
  - 词法 ∪ 向量混合排序，结果标 `why=vector|lexical|both`
  - 只索引 active、非 S、非 tainted；连不上就退回纯词法（fail-open）
  - 词法全空时用内置同义词表再查一次（零依赖）
- **候选沉淀**（挂 `session/event` → `turn/end` completed）
  - 只抽用户直输里的"长期约定"句式，走 `tool` 通道 → 闸门公理 → **pending 待审**
  - 每轮最多 2 条，落 L2/L3，带 `auto-capture` 标签
- **用进强化**：召回命中一次 α += 0.02（上限 1），写 `op=recall` 审计
- `lifecycleSummary()`，RPC `status` 返回 `lifecycle` 字段，面板可观测
- 市场资产：`locale/{zh,en}.json`、`docs/DETAIL{,.zh}.md`、`docs/preview.svg`、`icon.svg`
- 文档：[docs/生命周期-自动召回与候选.md](docs/生命周期-自动召回与候选.md)、[RELEASE.md](RELEASE.md)、[docs/演示脚本-30秒.md](docs/演示脚本-30秒.md)
- 回归：`tools/p25.mjs`（28 项）、`tools/p26.mjs`（31 项）

### 变更

- **包名 `dsh-workbench` → `dsh-sixlayer-memory`**：原名已被 lee259 占用（npm 0.16.1），
  `dsh-memory-core` 也已被 Sacredbluedragon 占用（0.1.10），两者都发不出去。
  改名由 `tools/rename-package.mjs` 完成（4 处代码 + profile 联接/bundles，全部回读校验）。
- 版本号 1.9.3 → 2.0.0（新增能力层，非破坏性：`lifecycle.enabled: false` 即退回 1.x 行为）
- `private: false`、`engines.dsh`、`publishConfig`、`prepublishOnly`（发布前自动跑全量检查）

### 修复

- **P0：插件没被加载**。`profiles/desktop/package.json` 的 `dsh.profile.bundles` 里缺包名，
  加载器直接跳过整个插件 —— 记忆库还在被写（旧进程），但新会话里 `mem_*` 一个都不注册。
  补回包名，并新增 `tools/register-bundle.mjs`（Node 写 JSON、无 BOM、写完回读校验）。
- **G9 误判**：现代安装路径只登记 `bundles`，插入行由 bundle 自带的 `cordis.patch.yml` 提供，
  但 preflight 只认 profile 的 patch。改为两处都认（`bundles✓ link✓ bundle-patch✓`）。
- **G7 与包名耦合**：原先硬编码 `dsh-memory-core` / `workbench` 两个旧名，改名即失效。
  改为按 realpath 判定"指向本包的联接必须唯一且等于包名"。
- **p13 退出崩溃**：Windows 上 `fetch`（undici keep-alive）+ `server.close()` + `process.exit`
  会踩 libuv `async.c` 断言（exit 0xC0000409）。p13 改用 `node:http` 且 `agent:false`，连跑三次稳定 exit 0。

### 已知未做

- 无遗忘衰减：只有 α 上调，没有随时间降权
- 无 LLM 二次抽取：候选沉淀是规则式，宁可漏不可滥
- 语义召回是可选外挂，需要自己起 embedding 服务；默认不开
- 市场条目尚未提交（等 npm 发布后 PR 社区索引）
