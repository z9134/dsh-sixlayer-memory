# 月度维护清单（每月 1 号）

> 由定时任务触发。目标：**不打断使用**的前提下，把插件保持可用、可发布、可回溯。
> 每一步都要有证据；跑不通就停下来说明卡在哪，不要"大概没问题"。

## 0. 先看现场（2 分钟）

```powershell
cd D:\001\CH002\dsh-memory-core
node tools/preflight.mjs          # 10 项
node tools/verify-all.mjs         # 31 个套件
Get-Content $env:USERPROFILE\.dsh\memory-core\diag.log -Tail 20
```

- 插件是否还在 profile 里：`node tools/register-bundle.mjs`（已在则输出 changed:false）
- 宿主版本：`(Get-Item $env:DSH_INSTALL_DIR\package.json).Version` 或 `npm view @deepseek-ai/dsh version`
- 数据体量：`D:\001\CH002\dsh-memory-data\db\memory.db` + `audit\` 行数

## 1. 跟宿主的兼容性

1. 比对 `package.json` 的 `engines.dsh` 与当前宿主版本；新版 DSH 若跨小版本（0.2.x → 0.3.x），先读升级指南再动。
2. 检查宿主有没有改 `agent/pre-step`、`session/event`、`systemPrompt.context` 的契约 —— 这三处是生命周期和注入的命根子。
3. 任何一处变了：先加适配，再跑回归，**不要先删功能**。

## 2. 依赖与安全

- 本插件**零运行时依赖**（只有 node 内置 + 可选 imageio-ffmpeg 用于做视频，不进包）。若未来引入依赖：必须 pin 版本、写 `engines`、跑 `npm audit`。
- 检查 `.npmignore` / `files` 有没有把本地路径、日志、备份打进包：`npm pack --dry-run` 看清单。

## 3. 数据与审计

```powershell
# 记录仪链是否连续（断链要立刻查）
mem_audit({ deep: true })
# 体量体检：FTS 行数 / 孤立标签 / 待审积压
mem_check()
```

- 快照：`store.snapshot()` 会写到 `dsh-memory-data/backup/`，确认最近一份日期。
- 待审积压超过 30 条：要么批量批准，要么调窄 `capture` 规则（见 README）。

## 4. 版本与日志

1. 有改动 → 升 `package.json` 版本（patch/minor 按影响），写 `CHANGELOG.md`（主题一句话 + 新增/变更/修复）。
2. 无改动也要在 CHANGELOG 记一行「本月无改动，回归全绿」，证明检查过。
3. 更新 `README.md` 的「当前版本」行。

## 5. 发布（仅在有 npm 登录态时）

```powershell
npm login --registry https://registry.npmjs.org     # 没有登录态就跳过本节，记在报告里
npm publish --registry https://registry.npmjs.org --access public
```

发布后：更新市场条目（`community.json` 里的版本/描述），必要时重录 40 秒视频（`tools/video/`）。

## 6. 每月产出（写进回复里）

- 回归结果：preflight 几项 PASS、verify 几个套件
- 宿主版本 vs 插件 `engines.dsh`
- 记录条数 / 待审条数 / 审计行数 / 最近快照日期
- 本月是否发布、是否改了契约、有没有需要用户决策的事
- **不超过 15 行**，先给结论再给数字
