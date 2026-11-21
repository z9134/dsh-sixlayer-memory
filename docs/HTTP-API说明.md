# 对外 HTTP API 说明（只读优先）

版本：0.8.0
用途：让**不在 DSH 进程里**的程序（QQ 机器人、脚本、云函数）调用记忆。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/memory-core/api/status` | 记录数 / 待审 / S 级 / schema / 审计（**不含 dataDir**） |
| POST | `/memory-core/api/recall` | `{ query, topK? }` → 检索结果，**不含 S 级** |
| POST | `/memory-core/api/read` | `{ record_id }` → 摘要与正文；S 级返回 403 |
| POST | `/memory-core/api/remember` | `{ content }` → 写入；**仅 allowWrite=true 时可用**，写入一律进待审 |

## 鉴权

两种头任选：

```
Authorization: Bearer <token>
x-api-token: <token>
```

token 来源：

1. 配置里写死：`config.api.token`
2. 留空 → 自动生成到 `D:\001\CH002\dsh-memory-data\meta\api-token.txt`

## 启用

`profiles/desktop/cordis.patch.yml`：

```yaml
        api:
          enabled: true
          token: ''
          allowWrite: false
          port: 47810
```

- `token` 留空 → 自动生成到 `meta/api-token.txt`
- `port: 47810` → 插件自己监听一个**固定端口**（127.0.0.1），不再受 DSH 随机端口影响；不配则只走 webServer 路由

重启后看 `docs/_rpc-diag.log` 是否有 `api: 已启用（写入=关）` 和 `api: 固定端口监听 127.0.0.1:47810`。

## 调用示例

```bash
TOKEN=$(cat "D:/001/CH002/dsh-memory-data/meta/api-token.txt")
PORT=47810   # 固定端口（config.api.port）

curl -s "http://127.0.0.1:$PORT/status" -H "Authorization: Bearer $TOKEN"

curl -s -X POST "http://127.0.0.1:$PORT/recall" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"记忆底座","topK":3}'
```

固定端口监听时，路径直接用 `/status`、`/recall`（不带 `/memory-core/api` 前缀）；
走 DSH webServer 路由时才需要完整路径 `/memory-core/api/status`。

## 安全约束

1. **默认只读**：`allowWrite=false` 时 `/remember` 直接 403
2. **S 级永不外发**：`/recall` 不含 S；`/read` 对 S 返回 403
3. **限流**：每分钟 120 次，超了 429
4. **同源围栏**：带 `Origin` 头的浏览器跨域请求会被 403（原始路由的既有校验），所以请在服务端/脚本里调
5. **端口会变**：DSH 每次重启端口不同，外部程序需要动态发现（建议从 `/memory-core` 的 GUI 端口读，或后续加固定端口）

## 已知限制

- 固定端口只监听 `127.0.0.1`：云端机器人要用，需要自己做隧道（cloudflared/frp），不要直接 `0.0.0.0` 暴露
- 没有 CORS：浏览器前端直接调会失败
- 没有分页：`topK` 上限 20
