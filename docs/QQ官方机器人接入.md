# QQ 官方机器人接入（QQ Bot v2）

版本：0.9.0
形态：插件内置 WebSocket 客户端，连腾讯网关；**不需要装 NapCat，也不需要本机 QQ 客户端**。

## 为什么选它

| 对比 | 官方机器人 | NapCat 本地 |
|---|---|---|
| 装 QQ 客户端 | 不用 | 要 |
| 封号风险 | 无（独立机器人号） | 有（个人号跑协议） |
| 公网要求 | 不用（WS 主动外连） | 不用 |
| 门槛 | 注册 + 审核 | 下载配置 |

## 你需要提供

1. **AppID**：已填好（1906207408）
2. **AppSecret**：填到 `D:\001\CH002\dsh-memory-data\meta\qq-bot.json` 的 `appSecret` 字段

```json
{
  "appId": "1906207408",
  "appSecret": "在这里填你的 Secret",
  "sandbox": false,
  "allowedOpenids": []
}
```

> Secret 不要贴在聊天里，也不要提交到 Git。这个文件只在本机。

## 启用

`profiles/desktop/cordis.patch.yml` 里已经加好：

```yaml
        qqOfficial:
          enabled: true
          appId: '1906207408'
          appSecret: ''
          sandbox: false
          allowedOpenids: []
```

`appSecret` 留空时插件会去读 `meta/qq-bot.json`。填好 Secret 后**重启 DSH**。

## 验证

1. 重启后看 `~/.dsh/memory-core/diag.log`：
   - 成功：`qq-official: 已启动 appId=1906207408`、`qq-official: 已连接网关`
   - 失败：会打印具体错误（token 失败 / 网关失败）
2. 在 QQ 里把机器人拉进群（或私聊），发 `/帮助`
3. 回复正常即通

## 白名单

- `allowedOpenids` 为空 = **不限制**（调试期方便，上线前建议填）
- 每个用户/群第一次说话时，日志里能看到 openid；填进去即可
- 群聊必须 @ 机器人（官方接口本身只推 @ 消息）

## 已知限制

- 官方机器人**只能在被拉进的群/单聊**里工作，不能主动加好友
- 消息内容是纯文本（图片/文件暂不处理）
- 单条回复有长度限制（约 2000 字），超长会被截断
- 沙箱环境把 `sandbox` 设 `true`，用 `sandbox.api.sgroup.qq.com`

## 和市场里的 QQ 插件怎么选

| 插件 | 适合 |
|---|---|
| **本插件（qqOfficial）** | 只想让记忆能被 QQ 调，零额外安装 |
| `qq-bridge`（Derpyu520） | 想让 AI 像真人水群、学黑话——但那套通常要 OneBot/NapCat |
| `RabiRoute` | 多机器人路由分发 |
| `AstrBot` / `LangBot` | 想要完整 IM 机器人平台（重，独立服务） |
