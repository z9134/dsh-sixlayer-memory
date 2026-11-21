# 板子 ASR 服务（方案 A 落地）

日期：2026-11-03
板子：Orange Pi AI Pro 8T（Ascend 310B4）· `192.168.0.198`

## 结论

**可用，而且比预期好。** 端到端 768ms（5.6 秒语音），识别准确。

## 服务

| 项 | 值 |
|---|---|
| 位置 | 板子 `/opt/voice-asr/asr_server.py` |
| 端口 | 8788 |
| 进程 | systemd `voice-asr.service`（Restart=always，已 enable） |
| 模型 | `/opt/wedetect/voice/asr_paraformer/model.int8.onnx`（243 MB） |
| 内存 | 379 MB（常驻） |
| 加载 | 首次约 4 秒（常驻后 0） |

### 接口

```
GET  /health   → {"ok":true,"service":"voice-asr","model":"paraformer-int8","uptime_s":N}
POST /asr      → body = 16k 单声道 WAV 字节
                 {"ok":true,"text":"...","ms":700,"dur_s":5.61}
```

## 实测（PC → 板子，局域网）

| wav | 时长 | 解码 | 端到端 |
|---|---|---|---|
| 0 | 5.61s | 700ms | **768ms** |
| 1 | 5.16s | 635ms | **669ms** |
| 2 | 4.53s | 564ms | **573ms** |

识别文本示例：`对我做了介绍啊那么我想说的是呢大家如果对我的研究感兴趣呢嗯`

## PC 侧调用

```js
import { boardAsr, boardHealth } from './lib/voice/board-asr.js'
const wav = await fs.promises.readFile('test.wav')
const r = await boardAsr(wav)          // { ok, text, ms, dur_s }
```

板子挂了要能降级：本地 whisper 或让用户打字（契约不变，只换实现）。

## 已知限制

- 只吃 **WAV**（16k 单声道）；webm/opus 需要先 ffmpeg 转换（板子上有 ffmpeg）
- 单线程锁：并发请求会排队（对单个通话够用）
- 板子负载高（NPU 驱动内核线程 D 状态），但 ASR 是 CPU 轻负载（RTF 0.13），不影响
- TTS 还没做（板子缺 VITS 模型）；一期先用 edge-tts（免费云端）

## 运维

```bash
systemctl status voice-asr
systemctl restart voice-asr
journalctl -u voice-asr -f
curl -s http://192.168.0.198:8788/health
```
