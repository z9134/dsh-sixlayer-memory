/**
 * board-asr.js — 调昇腾板子上的 ASR 服务（语音→文字）。
 *
 * 板子侧：/opt/voice-asr/asr_server.py（paraformer int8，systemd 管理，端口 8788）
 * 契约：POST /asr，body = 16k 单声道 WAV 字节；返回 { ok, text, ms, dur_s }
 *
 * 实测（2026-11-03）：5.6s 语音 → 端到端 768ms（解码 700ms + 网络 68ms）
 */
export const DEFAULT_BASE = 'http://192.168.0.198:8788'

export async function boardHealth({ baseUrl = DEFAULT_BASE, timeoutMs = 3000 } = {}) {
  const res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('板子 ASR 健康检查失败：HTTP ' + res.status)
  return res.json()
}

/**
 * @param {Buffer|Uint8Array} wav 16k 单声道 WAV
 * @returns {Promise<{ok: boolean, text: string, ms: number, dur_s: number}>}
 */
export async function boardAsr(wav, { baseUrl = DEFAULT_BASE, timeoutMs = 20000 } = {}) {
  const res = await fetch(baseUrl + '/asr', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json()
  if (!res.ok || !json.ok) throw new Error('板子 ASR 失败：' + (json.error || ('HTTP ' + res.status)))
  return json
}
