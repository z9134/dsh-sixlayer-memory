# 移植日志：luanyujia-workbench 协作与派单 → 记忆底座

- 日期：2026-10-31
- 来源：`一-协作机制.md`、`四-派单机制.md`
- 状态：代码完成，测试全绿；**待重启生效**

---

## 1. 移植了什么

| workbench 规则 | 记忆底座里的实现 |
|---|---|
| 派单 ≠ 公告（要动手 vs 只知悉） | `mem_dispatch({ kind: dispatch \| notice })` |
| 派单四件套：现象 / 照哪做 / 怎么验 / 回一句 | 缺任何一件直接拒绝 |
| 回执必须带证据（结论 + 证据 + 落盘 + 还差什么） | `mem_receipt`：缺结论或证据直接拒绝 |
| 同一件事 ≤3 条消息 | `messages` 计数，到 3 拒绝 |
| 状态机 sent → delivered → acked → done / failed | `mem_task` 推进状态，非法跃迁拒绝 |
| 「未回执」状态 | 超时（默认 24h）由台账查询判定为 `overdue` |
| 台账两张单：我发出没回的 / 别人等我回的 | `mem_task({ scope: 'outbound' \| 'inbound' })` |
| 修改权 A/C/B/D/E 分档 | `mem_scope`：越界返回"只能写请求" |

## 2. 改了什么

| 文件 | 改动 |
|---|---|
| `lib/schema.js` | `SCHEMA_VERSION 5 → 6`；新增 `tasks` 表与两个索引 |
| `lib/store.js` | `dispatchCreate / taskReceipt / taskMark / taskGet / taskList / taskOverdueCount` |
| `lib/policy.js` | `canWrite()`：A/C/B/D/E 分档判定 |
| `lib/tools.js` | 新增 `mem_dispatch / mem_receipt / mem_task / mem_scope`（19 → 23 个工具） |
| `lib/index.js` | RPC 增加 `tasks / task` |
| `lib/client.js` | 设置页新增「派单」标签：台账列表 + 详情 + 回执 |
| `tools/p5.mjs` | 新增 24 项回归 |

## 3. 状态机与上限

```
dispatchCreate → sent
      │  taskMark delivered
      ▼
  delivered ──(超时未回执)──► overdue（查询时判定，不改库）
      │  taskReceipt（结论+证据）
      ▼
   acked ── taskMark done ──► done
      │
      └── taskMark failed ──► failed
```

- **回执必须有结论和证据**：只说"好了"会被拒绝——没有证据的完成等于要求对方相信你。
- **≤3 条**：派单 1 条 + 回执 1 条 + 收尾知悉 1 条，超了拒绝。
- **销账只认 acked**：没回执的派单不能直接 done。

## 4. 修改权分档

| 档 | 场景 | 判定 |
|---|---|---|
| A | 共享宪法 | 只有 `ruleOwner` 能写，否则给"写请求"模板 |
| C | 共享工具/运行时 | 同上 |
| B | 板与台账 | 只能写自己那一行（`rowOwner === actor`） |
| D | 自己的地盘 | `actor === target` |
| E | 别人的地盘 | 一律拒绝，只能写请求 |

## 5. 测试

| 套件 | 结果 |
|---|---|
| `tools/p5.mjs`（新增） | 24/24 |
| `p1` / `p2` / `p3` / `p4` | 15 / 13 / 10 / 12 |
| `write-chain` / `smoke` / `phase2` | 20 / 19 / 23 |
| `validate-tools` | **23 个工具**，0 失败 |

## 6. 一个必须说清的边界

workbench 强调「派单必须真投递唤醒（发进对方会话）」。**这套工具做不到唤醒**——它只负责台账、状态、回执与超时判定；真正的"发消息给另一个会话"要由调用方（也就是我）在对话层完成，或者等 DSH 提供跨会话消息通道。

所以正确用法是：

1. 先 `mem_dispatch` 建单（拿到 task_id）；
2. 在对话层真的把内容发过去（或写进对方可见的地方）；
3. 对方干完回执时用 `mem_receipt` 挂到这个 task_id 上。

**只建单不投递，等于把公告当派单用**——这正是 workbench 里 8/36 执行率那次事故的原因。

## 7. 没移植的

- **真投递唤醒**：需要宿主消息通道，见上。
- **分诊扫描**：要扫台账 + 看板 + 体检 + 定位卡，跨多个文件系统，等有真实多场景再说。
- **地盘表 / 对话拓扑**：属于工作台文件组织，不是库能表达的。

## 8. 需要重启

schema v5 → v6 的迁移、`tasks` 表、客户端新增的「派单」标签，都要在启动时生效。
