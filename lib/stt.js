/**
 * 语音转写回落（执行文档 F3/F5）。
 *
 * 两级策略（对齐 Hermes）：
 *   ① QQ 内置 ASR：语音附件自带 `asr_refer_text`（腾讯识别，免费、零配置）——在
 *      transport 归一化时保留为 media.asrText，bridge 直接当文本用；
 *   ② 外部 STT 回落：未带 ASR 文本且部署配置了 OpenAI 兼容转写端点时，把下载到的
 *      音频字节 POST 到 `<baseUrl>/audio/transcriptions`（multipart，model + file）。
 *
 * 未配置时如实降级为「[语音消息（未启用转写）]」，不静默丢弃。
 */

export const STT_API_KEY_REF = 'QQ_STT_API_KEY'
export const DEFAULT_STT_MODEL = 'whisper-1'

/**
 * 调用 OpenAI 兼容的语音转写端点。
 * @param {object} spec
 * @param {Uint8Array|Buffer} spec.data - 音频字节。
 * @param {string} [spec.fileName]
 * @param {string} [spec.mime]
 * @param {{provider?: string, baseUrl: string, model?: string}} spec.stt - 配置。
 * @param {string} spec.apiKey
 * @param {Function} [spec.fetchImpl]
 * @param {AbortSignal} [spec.signal]
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function transcribeAudio({ data, fileName = 'voice.silk', mime = 'application/octet-stream', stt, apiKey, fetchImpl = globalThis.fetch, signal = undefined }) {
  if (stt === null || stt === undefined || typeof stt.baseUrl !== 'string' || stt.baseUrl.trim() === '') {
    return { ok: false, error: '未配置 STT 端点（stt.baseUrl）' }
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return { ok: false, error: `缺少 STT API key（凭据 ${STT_API_KEY_REF}）` }
  }
  if (data === undefined || data === null || data.byteLength === 0) {
    return { ok: false, error: '音频字节为空' }
  }
  const base = stt.baseUrl.trim().replace(/\/+$/, '')
  const url = `${base}/audio/transcriptions`
  const form = new FormData()
  form.append('model', stt.model !== undefined && stt.model !== '' ? stt.model : DEFAULT_STT_MODEL)
  form.append('file', new Blob([data], { type: mime }), fileName)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return { ok: false, error: `STT 请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    return { ok: false, error: `STT HTTP ${response.status}` }
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (text === '') return { ok: false, error: 'STT 未返回文本' }
  return { ok: true, text }
}

/**
 * 从 credentials 服务取 STT key（可选）。
 * @param {object} ctx
 * @returns {Promise<string>}
 */
export async function resolveSttApiKey(ctx) {
  const credentials = ctx?.get?.('credentials')
  if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(STT_API_KEY_REF)
      if (typeof hit?.value === 'string' && hit.value.trim() !== '') return hit.value.trim()
    } catch {
      /* 回落环境变量 */
    }
  }
  return String(process.env[STT_API_KEY_REF] ?? '').trim()
}

export default transcribeAudio
