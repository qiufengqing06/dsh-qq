/**
 * 共享 HTTP 工具：脱敏 + 媒体下载。
 *
 * 为什么要抽出来：两条线路各写了一份 `redact` 与 `downloadMedia`，行为已经漂移——
 * 官方线有 120s 超时，个人线**完全没有超时**（传了 signal 就只等对方）；脱敏规则也各漏一半。
 * 协议差异只应留在 transport，这种「网络公共逻辑」不该有两份。
 */

/** 日志/错误里绝不出现 secret/token：覆盖两条线路的已知形态。 */
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/(client_?secret|secret|token|access_token)"?\s*[:=]\s*"?[A-Za-z0-9._-]+/gi, '$1=***')
    .replace(/QQBot\s+[A-Za-z0-9._-]+/g, 'QQBot ***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')
    .replace(/(access_token=)[^&\s]+/gi, '$1***')
}

/** URL 脱敏：抹掉 userinfo（代理密码）与 token 类 query 参数。 */
export function redactUrl(url) {
  return String(url ?? '')
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@')
    .replace(/([?&](?:access_token|token)=)[^&#]*/gi, '$1***')
}

/** 超时信号（Node 18+ 有 AbortSignal.timeout；没有则手动实现）。 */
export function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

/**
 * 合并「调用方取消」与「下载超时」两个信号。
 *
 * 之前 qqbot 写的是 `signal ?? timeoutSignal(...)`：调用方一传 signal 就完全没有超时，
 * 服务器吊着不响应会永久挂住。这里用 AbortSignal.any 合并；旧运行时退化为调用方信号
 * （此时至少调用方自己能取消）。
 * @param {AbortSignal|undefined|null} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal|undefined}
 */
export function withTimeout(signal, timeoutMs) {
  const timeout = timeoutSignal(timeoutMs)
  if (signal === undefined || signal === null) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

/**
 * 下载一个 HTTP 媒体资源（大小上限 + 超时 + 可选鉴权头）。
 *
 * 返回统一结构：成功 `{ok:true, data, bytes, contentType}`；失败 `{ok:false, error, status?, retryable?}`。
 * 网络/读取错误标 retryable，HTTP 非 2xx 不标（重试同一地址没意义）；超限直接失败。
 *
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {number} options.maxBytes
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ok: true, data: Buffer, bytes: number, contentType: string} | {ok: false, error: string, status?: number, retryable?: boolean}>}
 */
export async function downloadHttp({ url, headers = {}, signal = undefined, timeoutMs = 120_000, maxBytes, fetchImpl = globalThis.fetch }) {
  const fail = (error, extra = {}) => ({ ok: false, error: String(error), ...extra })
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (error) {
    return fail(`媒体下载失败：${redactSecrets(error?.message ?? error)}`, { retryable: true })
  }
  if (!response.ok) return fail(`媒体下载 HTTP ${response.status}`, { status: response.status })
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(`媒体超过上限（${declared} > ${maxBytes} 字节）`)
  }
  let data
  try {
    data = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return fail(`媒体读取失败：${redactSecrets(error?.message ?? error)}`, { retryable: true })
  }
  if (data.byteLength > maxBytes) return fail(`媒体超过上限（${data.byteLength} > ${maxBytes} 字节）`)
  return {
    ok: true,
    data,
    bytes: data.byteLength,
    contentType: String(response.headers?.get?.('content-type') ?? ''),
  }
}
