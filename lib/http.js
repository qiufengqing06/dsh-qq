import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

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

/** 主机模式匹配：支持 example.com、example.com:8080、*.example.com 和 *。 */
export function mediaHostMatches(pattern, url) {
  const raw = String(pattern ?? '').trim().toLowerCase()
  if (raw === '') return false
  if (raw === '*') return true
  let value = raw
  if (value.includes('://')) {
    try {
      value = new URL(value).host.toLowerCase()
    } catch {
      return false
    }
  }
  const host = String(url?.host ?? '').toLowerCase()
  const hostname = String(url?.hostname ?? '').toLowerCase()
  if (value.startsWith('*.')) {
    const suffix = value.slice(1) // .example.com
    return hostname === value.slice(2) || hostname.endsWith(suffix)
  }
  return value === host || value === hostname
}

const PRIVATE_V4 = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [224, 0, 0, 0, 4],
]

function inV4Range(address, [a, b, c, d, bits]) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (base & mask)
}

/** 是否属于回环 / 私网 / 链路本地 / CGNAT / 保留地址（含 IPv4-mapped IPv6）。 */
export function isPrivateAddress(address) {
  const value = String(address ?? '').trim().toLowerCase()
  if (value === '') return true
  const family = isIP(value)
  if (family === 4) return PRIVATE_V4.some(range => inV4Range(value, range))
  if (family === 6) {
    if (value === '::' || value === '::1') return true
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice('::ffff:'.length).split('%')[0])
    const first = parseInt(value.split(':')[0] || '0', 16)
    if (!Number.isFinite(first)) return true
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true // multicast
    return false
  }
  return false
}

/**
 * 校验一个媒体 URL：协议 / userinfo / 主机白名单 / 私网地址。
 * 白名单命中时跳过私网检查（用户显式允许自建/私网源）。
 */
async function assertMediaUrl(rawUrl, { allowedHosts, allowPrivateHosts, lookup }) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return { ok: false, error: '媒体 URL 不合法' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: `不支持的媒体协议：${url.protocol}` }
  if (url.username !== '' || url.password !== '') return { ok: false, error: '媒体 URL 不允许携带 userinfo' }
  const hostname = url.hostname.toLowerCase()
  if (Array.isArray(allowedHosts) && allowedHosts.some(pattern => mediaHostMatches(pattern, url))) return { ok: true, url }
  if (allowPrivateHosts === true) return { ok: true, url }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return { ok: false, error: '媒体 URL 指向本机回环地址' }

  const literal = isIP(hostname)
  if (literal !== 0) {
    if (isPrivateAddress(hostname)) return { ok: false, error: '媒体 URL 指向私网/回环地址（如确需访问，请加入 media.allowedHosts）' }
    return { ok: true, url }
  }
  let addresses
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    // DNS 解析失败时交给 fetch 报错；解析成功才做私网检查。
    if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') return { ok: true, url }
    return { ok: false, error: `媒体域名解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: true, url }
  if (addresses.some(item => isPrivateAddress(item.address))) {
    return { ok: false, error: '媒体 URL 解析到私网/回环地址（如确需访问，请加入 media.allowedHosts）' }
  }
  return { ok: true, url }
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
export async function downloadHttp({
  url,
  headers = {},
  signal = undefined,
  timeoutMs = 120_000,
  maxBytes,
  fetchImpl = globalThis.fetch,
  allowedHosts = [],
  allowPrivateHosts = false,
  maxRedirects = 3,
  lookup = dnsLookup,
}) {
  const fail = (error, extra = {}) => ({ ok: false, error: String(error), ...extra })
  const hopLimit = Number.isSafeInteger(maxRedirects) && maxRedirects >= 0 ? maxRedirects : 3
  let currentUrl
  try {
    currentUrl = new URL(String(url))
  } catch {
    return fail('媒体 URL 不合法')
  }
  let requestHeaders = { ...headers }
  let response = null
  for (let hop = 0; hop <= hopLimit; hop += 1) {
    const checked = await assertMediaUrl(currentUrl, { allowedHosts, allowPrivateHosts, lookup })
    if (!checked.ok) return fail(checked.error)
    currentUrl = checked.url
    try {
      response = await fetchImpl(currentUrl.toString(), {
        method: 'GET',
        headers: requestHeaders,
        signal: withTimeout(signal, timeoutMs),
        redirect: 'manual',
      })
    } catch (error) {
      return fail(`媒体下载失败：${redactSecrets(error?.message ?? error)}`, { retryable: true })
    }
    const status = Number(response.status)
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      if (hop >= hopLimit) return fail(`媒体重定向次数超过上限（${hopLimit}）`, { status })
      const location = response.headers?.get?.('location')
      if (typeof location !== 'string' || location === '') return fail(`媒体重定向缺少 Location（HTTP ${status}）`, { status })
      let next
      try {
        next = new URL(location, currentUrl)
      } catch {
        return fail('媒体重定向地址不合法')
      }
      // 跨源重定向绝不能把鉴权头带过去
      if (next.origin !== currentUrl.origin) {
        delete requestHeaders.Authorization
        delete requestHeaders.authorization
      }
      currentUrl = next
      continue
    }
    break
  }
  if (response === null || response.ok !== true) {
    const status = response === null ? undefined : Number(response.status)
    return fail(`媒体下载 HTTP ${status}`, { status })
  }
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    return fail(`媒体超过上限（${declared} > ${limit} 字节）`)
  }
  const contentType = String(response.headers?.get?.('content-type') ?? '')

  // 流式读取：不能先 arrayBuffer() 再检查大小（缺 Content-Length 或服务器谎报时会把
  // 整个响应读进内存）。超过上限立即 cancel，内存占用有上界。
  if (response.body !== null && response.body !== undefined && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined || value === null) continue
        total += value.byteLength
        if (total > limit) {
          try {
            await reader.cancel()
          } catch {
            /* 取消失败不影响返回超限错误 */
          }
          return fail(`媒体超过上限（${total} > ${limit} 字节）`)
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      return fail(`媒体读取失败：${redactSecrets(error?.message ?? error)}`, { retryable: true })
    }
    return { ok: true, data: Buffer.concat(chunks, total), bytes: total, contentType }
  }

  // 极少数 fetch 实现没有 web stream body：退回整体读取，但仍有事后上限检查。
  let data
  try {
    data = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return fail(`媒体读取失败：${redactSecrets(error?.message ?? error)}`, { retryable: true })
  }
  if (data.byteLength > limit) return fail(`媒体超过上限（${data.byteLength} > ${limit} 字节）`)
  return { ok: true, data, bytes: data.byteLength, contentType }
}
