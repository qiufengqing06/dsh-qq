/**
 * QR 扫码登录 provider（执行文档 §5.6：onboarding 从 transport 中拆出，独立抽象）。
 *
 * 协议（对齐 Hermes gateway/platforms/qqbot/onboard.py + crypto.py）：
 *   ① POST https://<portal>/lite/create_bind_task   body {"key": <本地 AES-256 key, base64>}
 *      → {retcode:0, data:{task_id}}   —— key 只在本地生成，服务端用它加密 secret，明文不落网络
 *   ② 用户在手机 QQ 打开 connect.html?task_id=... 扫码/确认绑定
 *   ③ POST https://<portal>/lite/poll_bind_result   body {"task_id": ...}
 *      → {retcode:0, data:{status, bot_appid, bot_encrypt_secret, user_openid}}
 *        status: 0=NONE 1=PENDING 2=COMPLETED 3=EXPIRED
 *   ④ COMPLETED 后用本地 key 解出 client_secret（AES-256-GCM：IV(12)‖ciphertext‖AuthTag(16)）
 *
 * 独立成 provider 的好处：QQ 官方接口若变更，只需替换本文件，transport 与上层不受影响。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 扫码任务状态。 */
export const BIND_STATUS = Object.freeze({ NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 })

export const ONBOARD_CREATE_PATH = '/lite/create_bind_task'
export const ONBOARD_POLL_PATH = '/lite/poll_bind_result'

/** 扫码落地页：手机 QQ 打开即进入绑定流程。 */
export const QR_URL_TEMPLATE = 'https://{host}/qqbot/openclaw/connect.html?task_id={taskId}&_wv=2&source=dsh-qq'

export const DEFAULT_PORTAL_HOST = 'q.qq.com'
export const DEFAULT_POLL_INTERVAL_MS = 2_000
export const DEFAULT_TIMEOUT_MS = 600_000
export const MAX_QR_REFRESHES = 3

/** 生成 256 位绑定 key（base64）。 */
export function generateBindKey() {
  return randomBytes(32).toString('base64')
}

/**
 * AES-256-GCM 解密服务端返回的 client_secret。
 * 注意：解密必须用 createDecipheriv + setAuthTag（不是 createCipheriv）。
 * @param {string} encryptedBase64 - bot_encrypt_secret。
 * @param {string} keyBase64 - generateBindKey() 的产物。
 * @returns {string} 明文 client_secret
 */
export function decryptSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(String(keyBase64 ?? ''), 'base64')
  if (key.length !== 32) throw new TypeError('bind key 必须是 32 字节（base64）')
  const raw = Buffer.from(String(encryptedBase64 ?? ''), 'base64')
  if (raw.length <= 12 + 16) throw new TypeError('密文长度不足（需要 IV(12) + ciphertext + tag(16)）')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * 用同一密钥加密（仅自检与测试用；生产路径只解密）。
 * 输出布局与 QQ 服务端一致：IV(12) ‖ ciphertext ‖ AuthTag(16)，整体 base64。
 * @param {string} plaintext
 * @param {string} keyBase64
 * @returns {string} base64 密文
 */
export function encryptSecret(plaintext, keyBase64) {
  const key = Buffer.from(String(keyBase64 ?? ''), 'base64')
  if (key.length !== 32) throw new TypeError('bind key 必须是 32 字节（base64）')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, tag]).toString('base64')
}

/** 构造扫码 URL。 */
export function buildConnectUrl(taskId, portalHost = DEFAULT_PORTAL_HOST) {
  const host = String(portalHost ?? '').trim() === '' ? DEFAULT_PORTAL_HOST : String(portalHost).trim()
  return QR_URL_TEMPLATE.replace('{host}', host).replace('{taskId}', encodeURIComponent(String(taskId)))
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 请求头：q.qq.com 反爬要求 Accept: application/json（缺了会返回 JS 质询页）。 */
function portalHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `QQBotAdapter/0.1.0 (Node/${process.versions.node}; ${process.platform}; dsh-qq)`,
  }
}

/**
 * 创建 onboarding provider。
 * @param {object} [spec]
 * @param {Function} [spec.fetchImpl]
 * @param {string} [spec.portalHost]
 * @param {number} [spec.pollIntervalMs]
 * @param {number} [spec.timeoutMs]
 * @param {number} [spec.maxRefreshes]
 * @param {Function} [spec.sleep]
 * @param {object} [spec.logger]
 * @returns {object} provider
 */
export function createOnboardingProvider({
  fetchImpl = globalThis.fetch,
  portalHost = DEFAULT_PORTAL_HOST,
  baseUrl = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRefreshes = MAX_QR_REFRESHES,
  sleep = defaultSleep,
  logger = null,
} = {}) {
  // baseUrl 是测试注入口（真实门户恒为 https://<portalHost>）
  const base = baseUrl ?? `https://${portalHost}`
  const log = {
    info: message => {
      try {
        logger?.info?.(`[onboarding] ${message}`)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(`[onboarding] ${message}`)
      } catch {
        /* ignore */
      }
    },
  }

  async function post(path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: portalHeaders(),
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`)
    if (data === null || typeof data !== 'object') throw new Error(`${path} 返回非 JSON`)
    if (data.retcode !== 0) throw new Error(`${path} 失败：${data.msg ?? data.retcode}`)
    return data.data ?? {}
  }

  const provider = {
    portalHost,
    /** ① 创建绑定任务。 */
    async begin() {
      const key = generateBindKey()
      const data = await post(ONBOARD_CREATE_PATH, { key })
      const taskId = String(data.task_id ?? '')
      if (taskId === '') throw new Error('create_bind_task 未返回 task_id')
      log.info(`绑定任务已创建：${taskId}`)
      return { taskId, key, url: buildConnectUrl(taskId, portalHost) }
    },

    /** ③ 轮询一次绑定结果。 */
    async poll(taskId) {
      const data = await post(ONBOARD_POLL_PATH, { task_id: taskId })
      return {
        status: Number(data.status ?? BIND_STATUS.NONE),
        appId: String(data.bot_appid ?? ''),
        encryptedSecret: String(data.bot_encrypt_secret ?? ''),
        userOpenId: String(data.user_openid ?? ''),
      }
    },

    /**
     * ② 等待用户完成扫码。
     * @param {object} spec
     * @param {string} spec.taskId
     * @param {string} spec.key
     * @param {number} [spec.timeout]
     * @param {(info: {taskId: string, url: string}) => void} [spec.onRefresh] - 二维码过期换新时回调。
     * @param {AbortSignal} [spec.signal]
     * @returns {Promise<{appId: string, clientSecret: string, userOpenId: string}|null>}
     */
    async wait({ taskId, key, timeout = timeoutMs, onRefresh = null, signal = undefined }) {
      const deadline = Date.now() + timeout
      let currentTask = { taskId, key }
      let refreshes = 0

      for (;;) {
        while (Date.now() < deadline) {
          if (signal?.aborted === true) return null
          let result
          try {
            result = await provider.poll(currentTask.taskId)
          } catch (error) {
            log.warn(`轮询失败：${error instanceof Error ? error.message : String(error)}`)
            await sleep(pollIntervalMs)
            continue
          }
          if (result.status === BIND_STATUS.COMPLETED) {
            const clientSecret = decryptSecret(result.encryptedSecret, currentTask.key)
            log.info(`扫码完成，AppID=${result.appId}`)
            return { appId: result.appId, clientSecret, userOpenId: result.userOpenId }
          }
          if (result.status === BIND_STATUS.EXPIRED) {
            if (refreshes >= maxRefreshes) {
              log.warn(`二维码过期 ${maxRefreshes} 次，放弃`)
              return null
            }
            refreshes += 1
            log.info(`二维码过期，重新生成（${refreshes}/${maxRefreshes}）`)
            const next = await provider.begin()
            currentTask = { taskId: next.taskId, key: next.key }
            if (typeof onRefresh === 'function') onRefresh({ taskId: next.taskId, url: next.url })
            break // 重新进入轮询循环（deadline 不变）
          }
          await sleep(pollIntervalMs)
        }
        if (Date.now() >= deadline) {
          log.warn(`扫码等待超时（${timeout}ms）`)
          return null
        }
      }
    },

    /** begin + wait 的组合（一次性用法）。 */
    async scan({ timeout = timeoutMs, onProgress = null, signal = undefined } = {}) {
      const began = await provider.begin()
      if (typeof onProgress === 'function') onProgress({ taskId: began.taskId, url: began.url })
      return provider.wait({
        taskId: began.taskId,
        key: began.key,
        timeout,
        signal,
        onRefresh: info => {
          if (typeof onProgress === 'function') onProgress(info)
        },
      })
    },
  }

  return provider
}

export default createOnboardingProvider
