# 移植日志：luanyujia-workbench 记忆机制 → 记忆底座

- 日期：2026-10-31
- 来源：`https://github.com/mashanglinyu/luanyujia-workbench`（本地副本 `D:\001\CH001\luanyujia-workbench`）
- 范围：只移植**记忆机制**（00-核心机制/二-记忆机制.md）里能落到库上的部分

---

## 1. 为什么只移记忆机制

那个仓库是三套机制：

| 机制 | 内容 | 移了吗 |
|---|---|---|
| 协作机制 | 五档修改权、谁改哪里 | ❌ 属于多会话协作层 |
| **记忆机制** | 注入/私有/共享三层、§〇 交接、体量红线 | ✅ **本期移植** |
| 场景体系 | 六件套、开不开场景的判据 | ❌ 属于工作台文件组织 |

记忆机制是这个仓库里**唯一和"库"直接相关**的一套；协作与场景体系依赖文件目录和会话切换脚本，硬塞进记忆库会变成四不像。

## 2. 移植了什么

| workbench 概念 | 记忆底座里的实现 |
|---|---|
| `§〇 当前交接`（五小节、覆盖写、≤4 KB） | `handoffs` 表 + `mem_handoff` 工具（read/write） |
| 体量红线（交接 4 KB / 场景 25 KB / 待审 20） | `mem_check` 工具 + `store.checkBudgets()` |
| "只留最新一份，覆盖不追加" | `ON CONFLICT(scene) DO UPDATE` |
| "超了说明在写过程" | 写入端**硬拒绝**超 4 KB，并说明原因 |
| 场景记忆 ≤25 KB | 按 `project_id` 汇总记录正文长度 |

**五小节固定键**：`last`（上次交接）/ `projects`（当前项目）/ `changes`（变更）/ `next`（下一步）/ `blockers`（卡点）。

## 3. 改了什么

| 文件 | 改动 |
|---|---|
| `lib/schema.js` | `SCHEMA_VERSION 4 → 5`；新增 `handoffs` 表 |
| `lib/store.js` | `handoffWrite / handoffRead / handoffList / checkBudgets` |
| `lib/tools.js` | 新增 `mem_handoff`、`mem_check`（工具数 17 → 19） |
| `lib/index.js` | RPC 增加 `handoffs / handoff / check` |
| `lib/client.js` | 设置页新增「交接」标签：列表 + 五小节详情 + 体检按钮 |
| `tools/p4.mjs` | 新增 12 项回归 |
| `package.json` | `dshx.contributes.tools` 补两个工具 |

## 4. 测试

| 套件 | 结果 |
|---|---|
| `tools/p4.mjs`（新增） | 12/12 |
| `p1` / `p2` / `p3` | 15 / 13 / 10 |
| `write-chain` / `smoke` / `phase2` | 20 / 19 / 23 |
| `validate-tools` | 19 个工具，0 失败 |

## 5. 怎么用

```
mem_handoff({ scene: "memory-core", mode: "write", sections: { next: "…", blockers: "无" } })
mem_handoff({ scene: "memory-core" })
mem_check({ scene: "memory-core" })
```

换会话前：先写交接 → 跑 `mem_check` → 不过就别换。这是 workbench 里最实操的一条规矩，现在变成了工具。

## 6. 没移植的（如果以后要）

- **共享层四块板**（通知/待办/总索引/体检）：那是跨场景协作，得先有多场景。
- **派单状态机**：属于协作机制，和记忆库不是一个层面。
- **场景六件套的文件目录**：工作台是文件驱动的，记忆底座是库驱动的，两套存储不能硬合并。
- **`场景记忆.mjs` 的盖章/校验**：依赖文件哈希与目录结构，库里已有记录仪哈希链，重复实现没有收益。

## 7. 注意事项

1. 交接是**覆盖写**：写新的一份会替换旧的，旧的不会自动归档（workbench 是搬进 `归档\`，库里目前靠审计 trace 留痕）。
2. `scene` 建议直接用 `project_id`，这样 25 KB 的场景预算才能对上。
3. 体检里的"审计链"读的是启动时那次校验结果，不重新全量扫；要全量用 `mem_audit --deep`。
4. 需要再重启一次：schema v5 迁移 + 客户端新增标签页都要在启动时生效。
