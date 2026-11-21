# QQ 机器人接入说明

版本：0.7.0
形态：**OneBot v11 WebSocket 客户端**（插件主动连 NapCat/LLOneBot，不暴露端口）

## 架构

```
QQ 用户 ──> NapCat（OneBot 服务端，ws://127.0.0.1:3001）
                ▲
                │ WebSocket（事件下行 / API 上行）
                │
        dsh-memory-core 里的 QqBridge（lib/qq.js）
                │
                └── store：write / search / associate / stats
```

为什么是客户端而不是 webhook：DSH 的 webServer 端口每次重启会变，让 NapCat 反向 HTTP
指过来很脆弱；由我们连 NapCat 的固定端口，断线可重连。

## 命令

| 命令 | 作用 |
|---|---|
| `/记 <内容>` | 写入记忆（**先审后入**：status=pending） |
| `/搜 <关键词>` | 检索，返回前 3 条 |
| `/联想 <关键词>` | 由 A 想到 B（标签/语义/情绪三路） |
| `/最近` | 最近 5 条（不含 S 级） |
| `/状态` | 记录数 / 待审 / 审计 / schema |
| `/帮助` | 用法 |

## 安全约束

1. **白名单默认全拒**：`allowedUsers` / `allowedGroups` 没填就不响应任何消息。
2. **群聊必须 @ 机器人**，私聊不要求。
3. **限流**：同一用户 2 秒一条。
4. **QQ 写入一律 unverified**，走闸门进入 pending，需要 `mem_review` 批准才会 trusted。
5. **S 级永不外发**：`/最近`、`/搜`、`/联想` 都排除 S 级正文。

## 安装步骤

### 1. 装 NapCat（QQ 的 OneBot 实现）

- 下载：<https://github.com/NapNeko/NapCatQQ/releases>
- 需要本机有 **QQ NT 客户端**（桌面版）并登录
- 启动 NapCat 后，在它的 WebUI（默认 `http://127.0.0.1:6099`）里配置：
  - **WebSocket 服务端**：端口 `3001`
  - Token：留空，或填一个并同步到下面的 `accessToken`

### 2. 改插件配置

编辑 `C:\Users\HUAWEI\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
        qq:
          enabled: true                 # 改 true
          wsUrl: ws://127.0.0.1:3001
          accessToken: ''
          allowedUsers: ['你的QQ号']     # 私聊白名单
          allowedGroups: ['群号']        # 群白名单
```

### 3. 重启 DSH，确认连上

- 打开 设置 → 记忆底座 → 观测，`/状态` 里会看到 QQ 连接状态（或看 `docs/_rpc-diag.log` 里的 `qq: 已连接`）
- 私聊机器人发 `/帮助`，应收到命令列表

## 排障

| 现象 | 检查 |
|---|---|
| 没反应 | 白名单是否填了；群里是否 @ 了机器人 |
| 连不上 | NapCat 的 WS 服务端是否开在 3001；token 是否一致 |
| 连上但命令无效 | `docs/_rpc-diag.log` 是否有 `qq: 处理消息失败` |
| `/记` 回 `已记下（待审）` 但搜不到 | 待审记录默认不参与检索，先 `mem_review` 批准 |

## 风险提示

- NapCat 是**第三方**协议实现，用它跑 QQ 账号有**封号风险**，建议用**小号**测试
- 不要把机器人拉进大群；先私聊验证
- 机器人能读你记忆库里的 A 级记录，白名单只加可信账号
