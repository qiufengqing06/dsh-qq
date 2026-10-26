/**
 * OneBot 11 transport（二期）：接个人 QQ 号，后端首选 NapCat。
 *
 * 设计铁律（一期沿用，不得绕过）：
 *   - 协议差异只存在于本文件与 onebot-wire.js；上层禁止 `transport.kind === 'onebot'`；
 *   - 能力差异一律通过 capabilities() 表达（本实现：无 markdown / 无键盘按钮）；
 *   - 凭据只从 config 与 credentials seam 读，token 绝不进日志（redact）；
 *   - 所有 socket / 定时器 / 请求挂 ResourceScope，插件卸载一次性释放。
 *
 * 连接模型：正向 WS 优先（我们连 NapCat，默认 ws://127.0.0.1:3001），
 * 反向 WS（NapCat 连我们）作为可选能力见 config.onebot.reverseWs。
 *
 * 连接凭据怎么带：Node 内置 WebSocket 不支持自定义请求头，所以内置实现用
 * `?access_token=`（OneBot 11 通用写法）；若可选依赖 `ws` 可用，则优先用它并带
 * `Authorization: Bearer <token>`（规范写法）。
 */

import { downloadHttp, redactSecrets, redactUrl } from '../http.js'
import { buildChatKey, chunkText, makeCapabilities } from '../transport.js'
import { resolveOnboardingCredentials } from '../config.js'
import {
  classifyResponse,
  isAuthFailure,
  isReferenceFailure,
  normalizeOneBotEvent,
  parseSegments,
  replySegment,
  stripReplySegment,
  textSegments,
  toSegments,
} from './wire.js'

/** 重连退避（毫秒）。 */
export const ONEBOT_RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000]
/** 重连上限。 */
export const ONEBOT_MAX_RECONNECT_ATTEMPTS = 100
/** 单次 API 调用超时。 */
export const ONEBOT_API_TIMEOUT_MS = 15_000
/** 心跳判定周期（相对 heartbeatTimeoutMs 的三分之一，最小 1s）。 */
const HEARTBEAT_CHECK_MIN_MS = 1_000

/** 写操作：超时/断连时结果未知（可能已经生效），因此**不能自动重试**。 */
export function isMutatingAction(action) {
  return /^(send_|upload_|set_|delete_|kick_|ban_|friend_poke|send_like|mark_|clean_|set_self)/.test(String(action ?? ''))
}

/** 取端点的 host:port（诊断展示用，绝不带 token/query）。 */
export function wsHostOf(endpoint) {
  try {
    const url = new URL(String(endpoint ?? ''))
    return url.host
  } catch {
    return ''
  }
}

/** 脱敏端点：token 可能出现在 query 里，绝不进日志/状态。 */
/** WS 端点脱敏（token 类 query 参数一律遮蔽）。 */
export function redactEndpoint(endpoint) {
  return redactUrl(endpoint)
}

const ok = (extra = {}) => ({ ok: true, ...extra })
const fail = (error, extra = {}) => ({ ok: false, error: String(error), ...extra })

/** 失败原因脱敏（token 不出现在日志/错误里，与官方线共用一套规则）。 */
function redact(value) {
  return redactSecrets(value)
}

/**
 * 创建 OneBot 11 transport。
 * @param {object} spec
 * @param {object} spec.config - resolveConfig 结果（读取 config.onebot.*）
 * @param {object} spec.ctx - Cordis 上下文（credentials 服务可选）
 * @param {object} [spec.logger]
 * @param {object} spec.scope - ResourceScope
 * @param {object} [spec.deps] - 测试注入：socketFactory / now / backoffMs / maxReconnectAttempts / fetchImpl / token
 * @returns {object} transport（transport 契约）
 */
export function createTransport({ config, ctx, logger = null, scope, deps = {} }) {
  if (scope === undefined || scope === null) throw new TypeError('onebot transport requires a ResourceScope')
  const settings = config.onebot ?? {}
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const backoffMs = Array.isArray(deps.backoffMs) ? deps.backoffMs : ONEBOT_RECONNECT_BACKOFF_MS
  const maxReconnectAttempts = Number.isSafeInteger(deps.maxReconnectAttempts)
    ? deps.maxReconnectAttempts
    : ONEBOT_MAX_RECONNECT_ATTEMPTS
  const apiTimeoutMs = Number.isSafeInteger(settings.apiTimeoutMs) ? settings.apiTimeoutMs : ONEBOT_API_TIMEOUT_MS
  const heartbeatTimeoutMs = Number.isSafeInteger(settings.heartbeatTimeoutMs) ? settings.heartbeatTimeoutMs : 90_000
  const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))

  // 插件卸载/热重载时必须断开长连接：只清定时器不关 socket 会让旧实例继续收事件，
  // 真机踩过——改配置触发重载后出现两条 WS 连接，同一条 QQ 消息被两个实例各处理一遍。
  scope.add(() => stop(), 'onebot socket')

  const messageHandlers = new Set()
  const interactionHandlers = new Set()
  /** 后端画像（get_version_info 探测）：OneBot Core 之外的扩展能力按后端能力降级。 */
  let backend = { implementation: 'unknown', version: '', features: { inputStatus: false, getFile: false, uploadPrivateFile: false, localFilePath: false } }
  /**
   * 能力表 = OneBot 11 core 能力 + 后端扩展能力。
   * typing/文件类能力依赖后端扩展（set_input_status / get_file / upload_private_file），
   * 未探测到具体实现前一律按「不支持」声明，避免上层调用一个不存在的接口。
   */
  const capabilitiesOf = () =>
    makeCapabilities({
      markdown: false, // NapCat 的 markdown 段只在特定场景可用，不当作通用能力
      keyboard: false, // 没有按钮回调 → 审批自动降级为文本命令
      typing: backend.features.inputStatus === true,
      passiveReply: false, // OneBot 无被动回复窗口概念
      proactiveMessage: true,
      media: ['image', 'file', 'audio', 'video'],
    })
  let capabilities = capabilitiesOf()

  const log = {
    info: message => {
      try {
        logger?.info?.(`[onebot] ${message}`)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(`[onebot] ${message}`)
      } catch {
        /* ignore */
      }
    },
  }

  // ── 状态 ───────────────────────────────────────────────────────────
  let started = false
  let phase = 'stopped'
  let lastError = ''
  let endpoint = String(settings.wsUrl ?? '')
  let token = typeof deps.token === 'string' ? deps.token : ''
  let accountId = String(config.accountId ?? '')
  /** 机器人自己的昵称（get_login_info 返回）：被引用时用来标注「这条是机器人说的」。 */
  let accountName = ''
  let reconnectAttempts = 0
  let reconnectTimer = null
  let heartbeatTimer = null
  let connecting = false
  let bootstrapping = false
  let socket = null
  let lastFrameAt = 0
  let echoSeq = 0
  let sentMessages = 0
  /** 连接代次：重连后自增。pending 调用绑定代次，旧连接迟到的响应不得干扰新连接。 */
  let generation = 0
  /** 鉴权失败标记：一旦命中就停止重连（重试没有意义，等用户核对 token 后手动重连/重载）。 */
  let authFailed = false
  /** 测试用：显式覆盖 token（_setTokenForTest）。 */
  let tokenOverride = null
  let lastHeartbeatAt = 0
  /** 本次连接握手的 settle（start() 等待它，避免「刚建好 socket 就返回成功」） */
  let connectionSettled = null
  const pendingCalls = new Map()
  /**
   * 最近消息（messageId → {text, at}）：用于 reply 段的引用文本回填。
   * **入站与出站共用同一张表**——用户最常引用的是机器人刚发的那条，
   * 只记入站消息的话这种引用永远查不到文本（真机踩过，见 rememberOutbound）。
   */
  const recentMessages = new Map()
  /** 入站去重：复合键 → 时间戳。 */
  const seenMessages = new Map()
  /** 待处理的加好友/加群请求（P4）：flag → 详情。 */
  const pendingRequests = new Map()

  const RECENT_MESSAGE_LIMIT = 500
  /** 请求记录保留时长（过期后拒绝处理，避免对着早已失效的 flag 调接口）。 */
  const REQUEST_TTL_MS = 30 * 60 * 1000

  function setPhase(next, reason = '') {
    const previous = phase
    phase = next
    if (reason !== '') lastError = redact(reason)
    // 连上就把旧的失败原因清掉：否则 status().lastError 会一直挂着上次的错误
    //（真机踩过：重连成功后页面仍显示「接口调用超过频率限制」，与 meta.lastError 同类问题）。
    if (next === 'connected') lastError = ''
    if (previous !== next) log.info(`相位 ${previous} → ${next}${reason === '' ? '' : `（${redact(reason)}）`}`)
  }

  // ── 凭据 ───────────────────────────────────────────────────────────
  /**
   * 解析 access_token：credentials seam（推荐）→ 环境变量 → 配置。
   * OneBot 的 token 可以为空（NapCat 未启用 token 时），所以这里「空」是合法结果。
   * @returns {Promise<string>}
   */
  async function resolveToken() {
    if (tokenOverride !== null) return tokenOverride // 测试钩子（_setTokenForTest）
    if (typeof deps.token === 'string') return deps.token
    const fromConfig = String(settings.accessToken ?? '')
    if (fromConfig !== '') return fromConfig
    const fromSeam = await resolveOnboardingCredentials(ctx, ['ONEBOT_ACCESS_TOKEN'])
    const value = typeof fromSeam?.ONEBOT_ACCESS_TOKEN === 'string' ? fromSeam.ONEBOT_ACCESS_TOKEN.trim() : ''
    if (value !== '') return value
    return String(process.env.ONEBOT_ACCESS_TOKEN ?? '').trim()
  }

  // ── 连接 ───────────────────────────────────────────────────────────
  /** 默认 socket 工厂：优先可选依赖 ws（可带 Authorization 头），否则 Node 内置 WebSocket。 */
  function defaultSocketFactory(url, { token: authToken }) {
    return (async () => {
      if (authToken !== '') {
        try {
          const mod = await import('ws')
          const Ctor = mod.default ?? mod.WebSocket
          if (typeof Ctor === 'function') {
            return new Ctor(url, { headers: { Authorization: `Bearer ${authToken}` } })
          }
        } catch {
          // 可选依赖缺席：退回内置 WebSocket（token 走 query）
        }
      }
      return new WebSocket(url)
    })()
  }

  const socketFactory = typeof deps.socketFactory === 'function' ? deps.socketFactory : defaultSocketFactory

  /** 构造连接 URL：内置 WebSocket 不能带自定义头，token 只能走 query。 */
  function connectionUrl() {
    if (token === '') return endpoint
    if (/access_token=/i.test(endpoint)) return endpoint
    return `${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
  }

  /** 统一 socket 事件绑定（兼容内置 WebSocket 的 addEventListener 与 ws 的 on）。 */
  function attachSocket(target, handlers) {
    const bind = (event, fn) => {
      if (typeof target.addEventListener === 'function') {
        target.addEventListener(event, payload => {
          if (event === 'message') fn(payload?.data ?? payload)
          else if (event === 'close') fn(payload?.code ?? 1006, payload?.reason ?? '')
          else fn(payload)
        })
        return
      }
      if (typeof target.on === 'function') {
        if (event === 'close') target.on('close', (code, reason) => fn(code, reason))
        else target.on(event, fn)
      }
    }
    bind('open', () => handlers.onOpen?.())
    bind('message', data => handlers.onMessage?.(typeof data === 'string' ? data : String(data ?? '')))
    bind('close', (code, reason) => handlers.onClose?.(Number(code ?? 1006), String(reason ?? '')))
    bind('error', error => handlers.onError?.(error))
  }

  function sendRaw(payload) {
    if (socket === null || phase === 'stopped' || phase === 'disconnected' || phase === 'fatal') return false
    try {
      socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
      return true
    } catch (error) {
      log.warn(`发送失败：${redact(error?.message ?? error)}`)
      return false
    }
  }

  /** 连接建立后的引导：拿 self_id 作为账号命名空间，再进入 connected。 */
  async function bootstrap() {
    if (bootstrapping) return
    bootstrapping = true
    try {
      await bootstrapInner()
    } finally {
      bootstrapping = false
    }
  }

  async function bootstrapInner() {
    const response = await apiRequest('get_login_info', {})
    const parsed = classifyResponse(response, { action: 'get_login_info' })
    if (!parsed.ok) {
      connectionSettled?.resolve(false)
      closeSocket(1000, 'bootstrap failed')
      // 鉴权失败：重试无意义，停下来让用户核对 token（不排重连，看门狗也不会复活这一相位）
      if (isAuthFailure(parsed)) {
        authFailed = true
        setPhase(
          'auth-failed',
          `token 验证失败（retcode=${parsed.retcode}）：请核对 NapCat 网络配置里的 token 与凭据 ONEBOT_ACCESS_TOKEN 是否一致`,
        )
        log.warn(lastError)
        return
      }
      setPhase('disconnected', `get_login_info 失败：${parsed.error}`)
      scheduleReconnect()
      return
    }
    const selfId = String(parsed.data?.user_id ?? parsed.data?.uin ?? '')
    if (selfId === '') {
      setPhase('disconnected', 'get_login_info 未返回 user_id')
      connectionSettled?.resolve(false)
      closeSocket(1011, 'bootstrap failed')
      scheduleReconnect()
      return
    }
    accountId = selfId
    accountName = String(parsed.data?.nickname ?? '')
    authFailed = false
    await probeBackend()
    reconnectAttempts = 0
    lastFrameAt = now()
    setPhase('connected')
    log.info(`已连接（QQ ${accountId}，端点 ${redactEndpoint(endpoint)}）`)
    connectionSettled?.resolve(true)
  }

  /**
   * 探测后端实现（OneBot Core 之外的扩展能力按后端降级）：
   * get_version_info 是 OneBot 11 标准接口；识别到 NapCat 才启用它的扩展能力。
   */
  async function probeBackend() {
    const response = await apiRequest('get_version_info', {})
    const parsed = classifyResponse(response, { action: 'get_version_info' })
    const appName = String(parsed.data?.app_name ?? parsed.data?.appName ?? '')
    const version = String(parsed.data?.app_version ?? parsed.data?.version ?? '')
    const isNapCat = /napcat/i.test(appName)
    backend = {
      implementation: isNapCat ? 'napcat' : appName === '' ? 'unknown' : appName.toLowerCase(),
      version,
      features: {
        inputStatus: isNapCat,
        getFile: isNapCat,
        uploadPrivateFile: isNapCat,
        localFilePath: isNapCat,
      },
    }
    capabilities = capabilitiesOf()
    log.info(
      `后端画像：${backend.implementation}${version === '' ? '' : ` ${version}`}`
      + `（typing=${backend.features.inputStatus ? 'yes' : 'no'}，文件扩展=${backend.features.getFile ? 'yes' : 'no'}）`,
    )
  }

  async function connect() {
    if (connecting || !started || scope.disposed) return
    connecting = true
    clearReconnectTimer()
    try {
      setPhase(reconnectAttempts === 0 ? 'connecting' : 'reconnecting')
      const url = connectionUrl()
      const raw = await socketFactory(url, { token })
      if (!started || scope.disposed) {
        closeSocketOf(raw, 1000, 'stopped')
        return
      }
      socket = raw
      lastFrameAt = now()
      generation += 1
      connectionSettled = Promise.withResolvers()
      attachSocket(raw, {
        onOpen: () => {
          log.info('WebSocket 已连接，正在握手（get_login_info）')
          if (phase !== 'connected') fireDetached(bootstrap(), 'bootstrap')
        },
        onMessage: payload => {
          lastFrameAt = now()
          handlePayload(payload)
        },
        onClose: (code, reason) => handleClose(code, reason, raw),
        onError: error => log.warn(`WebSocket 错误：${redact(error?.message ?? error)}`),
      })
      // 等握手结果（get_login_info 成功 = 真的可用）；超时按失败处理，交给退避重连
      const settled = await Promise.race([
        connectionSettled.promise,
        new Promise(resolve => {
          scope.timer(() => resolve(false), apiTimeoutMs, { label: 'onebot handshake timeout' })
        }),
      ])
      // 注意：bootstrap 可能已经把相位设成 auth-failed（终端状态），这里不能又降级回
      // disconnected —— 否则用户看到的是「断开重连」而不是「token 不对，别再试了」。
      if (settled !== true && phase !== 'connected' && phase !== 'auth-failed' && !authFailed) {
        setPhase('disconnected', lastError === '' ? '握手超时（未收到 get_login_info 响应）' : lastError)
        closeSocket(1011, 'handshake timeout')
        scheduleReconnect()
      }
    } catch (error) {
      setPhase('disconnected', `连接失败：${redact(error?.message ?? error)}`)
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }

  /** 不 await 的异步调用统一兜底：rejection 会升到进程（Node 默认终止进程）。 */
  function fireDetached(promise, label) {
    Promise.resolve(promise).catch(error => {
      try {
        log.warn(`后台任务失败（${label}）：${redact(error?.message ?? error)}`)
      } catch {
        /* ignore */
      }
    })
  }

  function closeSocketOf(target, code, reason) {
    try {
      if (target === null || target === undefined || typeof target.close !== 'function') return
      // 浏览器 WebSocket API 只允许客户端发 1000 或 3000-4999；其它码（1005/1006/1011…）
      // 都会抛 InvalidAccessError，被 catch 吞掉后连接其实还活着（真机：心跳超时后双连接）。
      // 这种情况用 close() 不带参数，让实现自己挑合法码。
      if (code === 1000 || (code >= 3000 && code <= 4999)) target.close(code, reason)
      else target.close()
    } catch {
      /* ignore */
    }
  }

  function closeSocket(code, reason) {
    const current = socket
    socket = null
    if (code !== 1000) failPendingCalls(`本地关闭 code=${code}`)
    closeSocketOf(current, code, reason)
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) scope.clearTimer(reconnectTimer)
    reconnectTimer = null
  }

  function scheduleReconnect(forcedDelay = null) {
    if (!started || scope.disposed) return
    if (authFailed) return // 鉴权失败不重连：反复试错只会刷日志，等用户改 token
    if (reconnectTimer !== null) return
    if (reconnectAttempts >= maxReconnectAttempts) {
      setPhase('disconnected', `重连次数已达上限（最后错误：${lastError || '未知'}）`)
      return
    }
    const delay = forcedDelay ?? backoffMs[Math.min(reconnectAttempts, backoffMs.length - 1)]
    reconnectAttempts += 1
    setPhase('reconnecting')
    reconnectTimer = scope.timer(
      () => {
        reconnectTimer = null
        fireDetached(connect(), 'reconnect')
      },
      delay,
      { label: 'onebot reconnect' },
    )
  }

  function handleClose(code, reason, closedSocket = null) {
    if (closedSocket !== null && closedSocket !== socket) {
      log.info(`忽略旧连接的 close（code=${code}）`)
      return
    }
    socket = null
    failPendingCalls(`close code=${code}`)
    connectionSettled?.resolve(false)
    if (!started || scope.disposed) return
    if (code === 1006 && reconnectAttempts === 0 && token !== '') {
      log.warn('连接被拒（code=1006）：请核对 NapCat 网络配置里的 token 与 ONEBOT_ACCESS_TOKEN 是否一致')
    }
    log.warn(`WebSocket 关闭：code=${code} reason=${redact(reason)}`)
    if (code === 401 || code === 403) {
      setPhase('fatal', `鉴权失败（code=${code}）：请核对 NapCat 的 token 与 ONEBOT_ACCESS_TOKEN`)
      return
    }
    scheduleReconnect()
  }

  /** 心跳看门狗：NapCat 默认 30s 推一次 heartbeat；超时说明连接已死（半开 socket）。 */
  function startHeartbeatWatchdog() {
    if (heartbeatTimer !== null) return
    const interval = Math.max(HEARTBEAT_CHECK_MIN_MS, Math.floor(heartbeatTimeoutMs / 3))
    heartbeatTimer = scope.timer(
      () => {
        if (!started || scope.disposed) return
        if (phase !== 'connected') return
        if (now() - lastFrameAt <= heartbeatTimeoutMs) return
        log.warn(`超过 ${heartbeatTimeoutMs}ms 未收到任何帧，判定连接已死，主动重连`)
        setPhase('reconnecting', '心跳超时')
        closeSocket(1011, 'heartbeat timeout')
        scheduleReconnect(0)
      },
      interval,
      { repeat: true, label: 'onebot heartbeat watchdog' },
    )
  }

  // ── API 调用 ───────────────────────────────────────────────────────
  /**
   * 调用 OneBot API（`{action, params, echo}` → `{status, retcode, data, echo}`）。
   * @param {string} action
   * @param {object} params
   * @returns {Promise<object>} 原始响应体（null 表示未发出/超时）
   */
  function apiRequest(action, params = {}) {
    if (!socketUsable()) {
      return Promise.resolve(null)
    }
    echoSeq += 1
    const echo = `ob-${echoSeq}`
    const callGeneration = generation
    return new Promise(resolve => {
      const settle = response => {
        const pending = pendingCalls.get(echo)
        if (pending === undefined) return
        scope.clearTimer(pending.timer)
        pendingCalls.delete(echo)
        resolve(response)
      }
      const timer = scope.timer(
        () => {
          lastError = redact(`${action} 超时（${apiTimeoutMs}ms）`)
          log.warn(`${lastError}${isMutatingAction(action) ? '（写操作：结果未知，不自动重试）' : ''}`)
          settle(null)
        },
        apiTimeoutMs,
        { label: `onebot api ${action}` },
      )
      pendingCalls.set(echo, { action, generation: callGeneration, timer, resolve: settle })
      if (!sendRaw({ action, params, echo })) {
        settle(null)
      }
    })
  }

  /** 连接断开：立即结束所有在途调用（不必等 15s 超时）；写操作的结果标记为未知。 */
  function failPendingCalls(reason) {
    if (pendingCalls.size === 0) return
    log.warn(`连接中断，立即结束 ${pendingCalls.size} 个在途调用（${reason}）`)
    for (const pending of [...pendingCalls.values()]) pending.resolve(null)
  }

  /** 带分类结果的 API 调用。 */
  async function call(action, params) {
    if (!socketUsable()) {
      return fail('OneBot 未连接（请检查 NapCat 是否在运行、端点与 token 是否正确）', { retryable: true, retcode: -1 })
    }
    await throttle(action)
    const mutating = isMutatingAction(action)
    const response = await apiRequest(action, params)
    const classified = classifyResponse(response, { action, mutating })
    if (!classified.ok) {
      lastError = redact(classified.error)
      log.warn(lastError)
      return classified
    }
    if (/^(send_|upload_)/.test(action)) sentMessages += 1
    const messageId = classified.data?.message_id ?? classified.data?.messageId
    return messageId === undefined || messageId === null
      ? classified
      : { ...classified, messageId: String(messageId) }
  }

  // ── 入站 ───────────────────────────────────────────────────────────
  function handlePayload(text) {
    if (typeof text !== 'string' || text === '') return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      log.warn('收到无法解析的帧（非 JSON），已忽略')
      return
    }
    if (payload === null || typeof payload !== 'object') return

    // ① API 响应（带 echo）：必须与当前连接代次一致，旧连接迟到的响应直接丢弃
    if (payload.echo !== undefined && payload.echo !== null) {
      const pending = pendingCalls.get(String(payload.echo))
      if (pending === undefined) return
      if (pending.generation !== generation) {
        log.warn(`忽略旧连接（代次 ${pending.generation}）迟到的响应：${String(pending.action)}`)
        pending.resolve(null)
        return
      }
      pending.resolve(payload)
      return
    }

    // ② 事件
    const postType = String(payload.post_type ?? '')
    if (postType === 'meta_event') {
      if (payload.meta_event_type === 'heartbeat') lastHeartbeatAt = now()
      // 心跳/生命周期：lastFrameAt 已在收帧时更新，这里只在首次连接时补一次 bootstrap
      if (phase !== 'connected' && payload.meta_event_type === 'lifecycle') fireDetached(bootstrap(), 'bootstrap')
      return
    }
    if (postType === 'message') {
      // 收到消息也说明连接是活的；若还没握手完成（少数实现不推 lifecycle），补一次
      if (phase !== 'connected' && phase === 'connecting') fireDetached(bootstrap(), 'bootstrap')
      fireDetached(handleInbound(payload), 'handleInbound')
      return
    }
    if (postType === 'request') {
      recordRequest(payload)
      return
    }
    if (postType === 'notice') {
      handleNotice(payload)
      return
    }
    // message_sent / 其他：忽略
  }

  /** 引用查找表按 LRU 裁剪（入站 + 出站共用一张表）。 */
  function trimRecent() {
    while (recentMessages.size > RECENT_MESSAGE_LIMIT) {
      const oldest = recentMessages.keys().next().value
      recentMessages.delete(oldest)
    }
  }

  function rememberMessage(event) {
    if (event.messageId === '') return
    // 连附件与发送人一起记：QQ 里文件和文字没法合成一条消息，群文件的标准用法就是
    // 「先发文件，再引用它提问」——被引用那条本身没有文本，只记 text 会让引用退化成空引用
    //（真机 2026-09-24：机器人只能回「我这边没有附件」）。发送人同理：引用别人的消息时，
    // 模型必须知道「这句话是谁说的」（真机 2026-09-24：引用群友消息，模型不知道是谁发的）。
    recentMessages.set(event.messageId, {
      text: event.text,
      at: now(),
      sender: { id: event.sender?.id ?? '', name: event.sender?.name ?? '' },
      ...(Array.isArray(event.media) && event.media.length > 0 ? { media: event.media } : {}),
    })
    trimRecent()
  }

  /**
   * 当前消息引用了哪条消息（没有引用返回空串）。
   * @param {Array<object>|string} rawMessage - OneBot 的 message 字段（array 或 CQ 字符串）
   * @returns {string}
   */
  function replyIdOf(rawMessage) {
    for (const segment of toSegments(rawMessage)) {
      if (segment?.type === 'reply') return String(segment.data?.id ?? segment.data?.message_id ?? '')
    }
    return ''
  }

  /**
   * 补全被引用的消息：内存里没有就向 NapCat 要（`get_msg`）。
   *
   * 为什么必须：`recentMessages` 是**内存**表，插件一重启就空了。用户引用「重启前收到的消息」时
   * replyTo 全空，模型只看到「这句话是什么」这种没头没尾的问题——真机 2026-09-24：
   * 重启后引用 30 分钟前群里那句「我是秦始皇」直接失效，而重启前同样的引用是好的。
   * NapCat 自己保留最近约 5000 条消息，`get_msg` 能把原文/发送人/附件取回来，
   * 于是内存表退回它本来的角色：快路径，而不是唯一路径。
   * @param {object} raw - 原始 OneBot 事件
   */
  async function hydrateQuoted(raw) {
    const id = replyIdOf(raw?.message)
    if (id === '' || recentMessages.has(id)) return
    const numeric = Number(id)
    const result = await call('get_msg', { message_id: Number.isFinite(numeric) ? numeric : id })
    if (!result.ok) {
      // 取不到（超出 NapCat 的 LRU 窗口 / 已撤回）就如实留空，不编造被引内容
      log.info(`被引用消息取不到（${id}）：${result.error ?? '未知原因'}`)
      return
    }
    const data = result.data ?? {}
    const parsed = parseSegments(toSegments(data.message ?? data.raw_message ?? ''), { selfId: accountId })
    const card = String(data.sender?.card ?? '')
    const nickname = String(data.sender?.nickname ?? '')
    const sender = {
      id: String(data.sender?.user_id ?? data.user_id ?? ''),
      name: card !== '' ? card : nickname,
    }
    recentMessages.set(id, {
      text: parsed.text,
      at: now(),
      sender,
      ...(parsed.media.length > 0 ? { media: parsed.media } : {}),
    })
    trimRecent()
    log.info(`被引用消息不在内存里，已用 get_msg 取回（${id}）`)
  }

  /**
   * 记住**自己发出去**的消息（出站）。
   *
   * 真机踩过（2026-09-24）：用户「引用机器人某条消息」再提问时，reply 段里的 id 是
   * 我们自己发出去的消息 id；只记入站消息的话 `lookupReply` 永远查不到 →
   * `replyTo.text` 为空 → bridge 整块跳过引用 → 模型只看到「我引用的这句话是什么」
   * 这种没头没尾的问题，只能回一句「我没收到引用内容」。
   */
  function rememberOutbound(messageId, text) {
    const id = String(messageId ?? '')
    if (id === '') return
    // 带上机器人自己的身份：对方引用「机器人说过的话」时，模型需要知道那句话是自己说的。
    recentMessages.set(id, {
      text: String(text ?? ''),
      at: now(),
      ...(accountId === '' ? {} : { sender: { id: accountId, name: accountName } }),
    })
    trimRecent()
  }

  /** 出站消息在引用表里的可读文本（媒体没有正文时给个占位，别留空）。 */
  function outboundLabel(kind, name, caption) {
    const label =
      { image: '[图片]', audio: '[语音]', video: '[视频]', file: `[文件${name === '' ? '' : ` ${name}`}]` }[kind] ?? '[附件]'
    return caption === '' ? label : `${label} ${caption}`
  }

  /**
   * 入站去重（复合键）：只用 message_id 在跨群/跨账号/跨后端时有碰撞风险，
   * 键里带上 chatKey。窗口与容量复用全局配置（dedupWindowMs / dedupMaxSize）。
   */
  function isDuplicateEvent(chatKey, messageId) {
    if (messageId === '') return false
    const key = `${chatKey}:msg:${messageId}`
    const at = now()
    const seen = seenMessages.get(key)
    if (seen !== undefined && at - seen < config.dedupWindowMs) return true
    seenMessages.set(key, at)
    if (seenMessages.size > config.dedupMaxSize) {
      for (const [k, time] of seenMessages) {
        if (at - time >= config.dedupWindowMs) seenMessages.delete(k)
      }
      while (seenMessages.size > config.dedupMaxSize) {
        const oldest = seenMessages.keys().next().value
        seenMessages.delete(oldest)
      }
    }
    return false
  }

  /** 轻量 chatKey（不依赖归一化，也不触发 get_msg）：去重要在 hydrate 之前做。 */
  function rawChatKeyOf(raw) {
    const kind = raw?.message_type
    try {
      if (kind === 'group' && raw?.group_id !== undefined && raw?.group_id !== null) {
        return buildChatKey('onebot', accountId === '' ? 'unknown' : accountId, { kind: 'group', groupId: String(raw.group_id) })
      }
      if (kind === 'private' && raw?.user_id !== undefined && raw?.user_id !== null) {
        return buildChatKey('onebot', accountId === '' ? 'unknown' : accountId, { kind: 'dm', userId: String(raw.user_id) })
      }
    } catch {
      /* 缺字段：交给归一化处理 */
    }
    return ''
  }

  function rawMessageIdOf(raw) {
    return String(raw?.message_id ?? raw?.message?.message_id ?? '')
  }

  async function handleInbound(raw) {
    // 自身消息防御性过滤：即使 NapCat 关了 reportSelfMessage，也不要让「自己发的消息」
    // 进桥接，否则极端情况下会自问自答成环。
    if (accountId !== '' && String(raw?.user_id ?? '') === accountId) return
    // 去重必须在 hydrate 之前：重复事件不该再触发一次 get_msg（网络差时重复投递很常见），
    // 也不该因为「引用补全耗时」让同一条消息在窗口里被处理两遍。
    const preflightKey = rawChatKeyOf(raw)
    const preflightId = rawMessageIdOf(raw)
    if (preflightKey !== '' && isDuplicateEvent(preflightKey, preflightId)) {
      log.info(`忽略重复事件（preflight）：${preflightKey} msg=${preflightId}`)
      return
    }
    await hydrateQuoted(raw)
    let event
    try {
      event = normalizeOneBotEvent(raw, {
        accountId,
        selfId: accountId,
        lookupReply: id => recentMessages.get(String(id)) ?? null,
      })
    } catch (error) {
      log.warn(`事件归一化失败：${redact(error?.message ?? error)}`)
      return
    }
    if (event === null) return
    // 归一化后的键与 preflight 键可能不同（缺字段的畸形事件）：再兜一层，但不再重复标记时间戳
    if (preflightKey === '' && isDuplicateEvent(event.chatKey, event.messageId)) {
      log.info(`忽略重复事件：${event.chatKey} msg=${event.messageId}`)
      return
    }
    rememberMessage(event)
    for (const handler of [...messageHandlers]) {
      try {
        const result = handler(event)
        if (result !== undefined && typeof result.then === 'function') await result
      } catch (error) {
        log.warn(`入站处理失败：${redact(error?.message ?? error)}`)
      }
    }
  }

  /** 加好友/加群请求：记下来给主人处理（/qq-requests 查看，/qq-request <flag> allow|deny）。 */
  function recordRequest(raw) {
    const flag = String(raw.flag ?? '')
    if (flag === '') return
    const type = String(raw.request_type ?? '')
    const detail = {
      flag,
      type, // friend | group
      subType: String(raw.sub_type ?? ''), // add | invite —— 处理群请求时 OneBot 要求回传
      userId: String(raw.user_id ?? ''),
      groupId: raw.group_id === undefined ? '' : String(raw.group_id),
      comment: String(raw.comment ?? ''),
      at: now(),
      expiresAt: now() + REQUEST_TTL_MS,
      handled: false,
    }
    pendingRequests.set(flag, detail)
    log.info(`收到${type === 'group' ? '加群' : '加好友'}请求：${detail.userId}${detail.comment === '' ? '' : `（${detail.comment}）`}`)
  }

  function handleNotice(raw) {
    const noticeType = String(raw.notice_type ?? '')
    if (noticeType === 'friend_add' || noticeType === 'group_increase') {
      log.info(`notice ${noticeType}：${String(raw.user_id ?? '')}`)
    }
  }

  // ── 出站 ───────────────────────────────────────────────────────────
  /**
   * socket 是否可用于发请求：connecting/reconnecting 阶段 socket 可能已经通了
   * （OneBot 是双工长连接，握手与业务请求走同一条链路），所以不能只看 connected。
   */
  function socketUsable() {
    return phase === 'connected' || phase === 'connecting' || phase === 'reconnecting'
  }

  /**
   * 出站限速（个人号风控友好）：消息类调用之间至少间隔 sendRateLimitMs。
   * 用真实时钟（Date.now），与可注入的 now() 无关——限速是物理时间语义。
   */
  let lastSendAt = 0
  /** 出站串行链：并发调用依次排队，否则两个并发 send 会同时通过限速检查（取时间戳在等待前）。 */
  let outboundChain = Promise.resolve()
  async function throttle(action) {
    const gap = settings.sendRateLimitMs
    if (!Number.isFinite(gap) || gap <= 0) return
    if (!/^(send_|upload_)/.test(action)) return
    const slot = outboundChain.then(async () => {
      const wait = lastSendAt + gap - Date.now()
      if (wait > 0) await new Promise(resolve => scope.timer(resolve, wait, { label: 'onebot send throttle' }))
      lastSendAt = Date.now()
    })
    // 链本身吞掉错误（send 失败不能卡死后续发送），但当前调用仍能感知自己的等待
    outboundChain = slot.catch(() => {})
    await slot
  }

  function messageAction(target) {
    if (target.kind === 'dm') return { action: 'send_private_msg', idField: 'user_id', id: target.userId }
    if (target.kind === 'group') return { action: 'send_group_msg', idField: 'group_id', id: target.groupId }
    return null
  }

  /**
   * 发消息段数组 + 引用失效兜底（NapCat 的 message_id 是 LRU 哈希，引用可能过期）。
   * @param {object} target
   * @param {Array<object>} segments
   * @param {string} reference - 本次引用的 message_id（空 = 不引用）
   * @returns {Promise<object>} call 结果
   */
  async function postSegments(target, segments, reference) {
    const mapping = messageAction(target)
    if (mapping === null) return fail('OneBot 不支持该目标类型（只有私聊与群聊）')
    const first = await call(mapping.action, { [mapping.idField]: mapping.id, message: segments })
    if (first.ok || reference === '' || !isReferenceFailure(first)) return first
    log.warn(`引用失效（${redact(first.error)}），去掉引用重发一次`)
    return call(mapping.action, { [mapping.idField]: mapping.id, message: stripReplySegment(segments) })
  }

  async function sendText(target, text, opts = {}) {
    const content = String(text ?? '')
    if (content.trim() === '') return ok()
    const mapping = messageAction(target)
    if (mapping === null) return fail('OneBot 不支持该目标类型（只有私聊与群聊）')
    const reference = typeof opts.replyTo === 'string' ? opts.replyTo : ''
    const chunks = chunkText(content)
    let last = ok()
    for (const [index, chunk] of chunks.entries()) {
      const segments = [...(index === 0 ? replySegment(reference) : []), ...textSegments(chunk)]
      last = await postSegments(target, segments, index === 0 ? reference : '')
      if (!last.ok) return last
      rememberOutbound(last.messageId, chunk) // 供对方「引用机器人这条消息」时回填原文
    }
    return last
  }

  /** 媒体引用 → OneBot 的 file 字段（NapCat 支持 base64:// / 本地路径 / http(s) / file://）。 */
  function mediaFileRef(media) {
    if (typeof media.base64 === 'string' && media.base64 !== '') return `base64://${media.base64}`
    if (typeof media.path === 'string' && media.path !== '') return media.path
    if (typeof media.url === 'string' && media.url !== '') return media.url
    return ''
  }

  async function sendMedia(target, media, opts = {}) {
    if (media === null || typeof media !== 'object') return fail('sendMedia 需要 media 对象')
    const file = mediaFileRef(media)
    if (file === '') return fail('sendMedia 需要 url / base64 / path 之一')
    const mapping = messageAction(target)
    if (mapping === null) return fail('OneBot 不支持该目标类型（只有私聊与群聊）')
    const caption = typeof media.caption === 'string' ? media.caption : typeof opts.caption === 'string' ? opts.caption : ''
    const reference = typeof opts.replyTo === 'string' ? opts.replyTo : ''
    const name = typeof media.fileName === 'string' && media.fileName !== '' ? media.fileName : ''

    // 文件：走上传接口（群/私聊各有 action），不是消息段
    if (media.kind === 'file') {
      const action = target.kind === 'dm' ? 'upload_private_file' : 'upload_group_file'
      const idField = target.kind === 'dm' ? 'user_id' : 'group_id'
      const uploaded = await call(action, { [idField]: mapping.id, file, name: name === '' ? 'file.bin' : name })
      if (!uploaded.ok) return uploaded
      rememberOutbound(uploaded.messageId, outboundLabel('file', name, caption))
      if (caption !== '') {
        const textResult = await postSegments(target, textSegments(caption), reference)
        if (!textResult.ok) return textResult
        rememberOutbound(textResult.messageId, caption)
      }
      return uploaded
    }

    // 图片/语音/视频：作为消息段发出（可与说明文字混排成一条）
    const segmentType = media.kind === 'image' ? 'image' : media.kind === 'audio' ? 'record' : 'video'
    const segments = [
      ...replySegment(reference),
      { type: segmentType, data: { file } },
      ...(caption === '' ? [] : textSegments(caption)),
    ]
    const sent = await postSegments(target, segments, reference)
    if (sent.ok) rememberOutbound(sent.messageId, outboundLabel(media.kind, name, caption))
    return sent
  }

  function sendKeyboard() {
    // capabilities().keyboard = false：上层不会走这里；真被调到也要如实报错而不是静默丢
    return Promise.resolve(fail('OneBot 协议没有消息按钮，审批请用文本命令（/qq-approve）'))
  }

  async function sendTyping(target) {
    // NapCat 的 set_input_status 只针对用户，群聊没有对应的输入状态接口
    if (target.kind !== 'dm') return ok({ skipped: true })
    const result = await call('set_input_status', { user_id: target.userId, event_type: 1 })
    // 输入状态失败不影响主链路（best-effort）
    return result.ok ? ok() : ok({ skipped: true, error: result.error })
  }

  /** 是否与 OneBot 服务同源（决定能否带 token 拉媒体，避免把 token 泄漏给第三方 CDN）。 */
  function sameOrigin(url) {
    if (endpoint === '') return false
    try {
      const target = new URL(String(url))
      const base = new URL(endpoint.replace(/^ws/, 'http'))
      return target.host === base.host
    } catch {
      return false
    }
  }

  /**
   * get_file 返回本地路径时允许读取的根目录：
   * ① dataDir（插件自己的数据目录）；② napcat.fileRoot（显式配置）；
   * ③ 从 napcat.qrFile 推导的 NapCat 安装根（qrFile 位于 <root>/opt/... 时取 /opt 前缀）。
   * 空列表之外一律拒绝，避免被伪造的 get_file 响应读取任意本地文件。
   */
  function localMediaRoots() {
    const roots = [String(config.dataDir ?? '').trim()]
    const explicit = String(config.napcat?.fileRoot ?? '').trim()
    if (explicit !== '') roots.push(explicit)
    const qr = String(config.napcat?.qrFile ?? '').trim().replace(/\\/g, '/')
    if (qr !== '') {
      const opt = qr.indexOf('/opt/')
      roots.push(opt > 0 ? qr.slice(0, opt) : qr.slice(0, Math.max(0, qr.lastIndexOf('/'))))
    }
    return roots.filter(root => root !== '')
  }

  async function downloadMedia(url, { maxBytes = config.maxFileBytes, signal = undefined } = {}) {
    const ref = String(url ?? '')
    if (ref === '') return fail('downloadMedia 需要 url')

    // ① 内联 base64 / data URL
    // 先按编码长度预检：直接 Buffer.from 会把超大输入整块解码进内存，事后检查就晚了。
    const encodedTooLarge = encoded =>
      Number.isFinite(maxBytes) && maxBytes > 0 && encoded.length > Math.ceil(maxBytes / 3) * 4 + 4
    if (ref.startsWith('base64://')) {
      const encoded = ref.slice('base64://'.length)
      if (encodedTooLarge(encoded)) return fail(`媒体超过上限（编码长度 ${encoded.length} 超过 ${maxBytes} 字节上限）`)
      const data = Buffer.from(encoded, 'base64')
      if (data.byteLength > maxBytes) return fail(`媒体超过上限（${data.byteLength} > ${maxBytes} 字节）`)
      return ok({ data, bytes: data.byteLength, contentType: '' })
    }
    if (ref.startsWith('data:')) {
      const index = ref.indexOf(',')
      const meta = index < 0 ? '' : ref.slice(5, index)
      const payload = index < 0 ? '' : ref.slice(index + 1)
      if (meta.includes('base64') && encodedTooLarge(payload)) {
        return fail(`媒体超过上限（编码长度 ${payload.length} 超过 ${maxBytes} 字节上限）`)
      }
      const data = Buffer.from(payload, meta.includes('base64') ? 'base64' : 'utf8')
      if (data.byteLength > maxBytes) return fail(`媒体超过上限（${data.byteLength} > ${maxBytes} 字节）`)
      return ok({ data, bytes: data.byteLength, contentType: meta.replace(/;base64$/, '') })
    }

    // ② file:// / 本地路径：先 get_file 拿到可下载地址
    let httpUrl = /^https?:\/\//i.test(ref) ? ref : ''
    if (httpUrl === '') {
      const resolved = await call('get_file', { file: ref })
      if (!resolved.ok) return fail(`取文件失败：${resolved.error}`)
      const candidate = String(resolved.data?.url || resolved.data?.file || '')
      if (!/^https?:\/\//i.test(candidate)) {
        // NapCat 同机部署时 get_file 会给本地路径：只在允许根目录内读，先 realpath + stat。
        try {
          const fs = await import('node:fs/promises')
          const { sep } = await import('node:path')
          const resolved = await fs.realpath(candidate)
          const roots = []
          for (const root of localMediaRoots()) {
            try {
              roots.push(await fs.realpath(root))
            } catch {
              /* 根目录不存在时忽略 */
            }
          }
          const inside = roots.some(root => resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep))
          if (!inside) return fail('get_file 返回的本地路径不在允许目录内')
          const info = await fs.stat(resolved)
          if (!info.isFile()) return fail('get_file 返回的本地路径不是文件')
          if (Number.isFinite(maxBytes) && info.size > maxBytes) return fail(`媒体超过上限（${info.size} > ${maxBytes} 字节）`)
          const data = await fs.readFile(resolved)
          if (data.byteLength > maxBytes) return fail(`媒体超过上限（${data.byteLength} > ${maxBytes} 字节）`)
          return ok({ data, bytes: data.byteLength, contentType: '' })
        } catch {
          return fail(`get_file 未返回可下载地址（${ref}）`)
        }
      }
      httpUrl = candidate
    }

    // ③ HTTP 拉取（同源时带上 token；第三方 CDN 绝不带；统一 120s 超时 + 上限）
    const media = config.media ?? {}
    const endpointHost = (() => {
      try {
        return new URL(endpoint.replace(/^ws/, 'http')).host
      } catch {
        return ''
      }
    })()
    const allowedHosts = [endpointHost, ...(Array.isArray(media.allowedHosts) ? media.allowedHosts : [])].filter(Boolean)
    const downloaded = await downloadHttp({
      url: httpUrl,
      headers: sameOrigin(httpUrl) && token !== '' ? { Authorization: `Bearer ${token}` } : {},
      signal,
      timeoutMs: 120_000,
      maxBytes,
      fetchImpl,
      allowedHosts,
      allowPrivateHosts: media.allowPrivateHosts === true,
      maxRedirects: Number.isSafeInteger(media.maxRedirects) ? media.maxRedirects : 3,
    })
    if (downloaded.ok !== true) return downloaded
    return ok({ data: downloaded.data, bytes: downloaded.bytes, contentType: downloaded.contentType })
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  async function start() {
    if (started) return true
    started = true
    authFailed = false // 每次显式 start（含 /qq-reconnect）都重新尝试鉴权
    endpoint = String(settings.wsUrl ?? '').trim()
    if (endpoint === '') {
      started = false
      setPhase('no-credentials', '未配置 onebot.wsUrl（NapCat 的 WebSocket 服务端地址，例如 ws://127.0.0.1:3001）')
      log.warn(lastError)
      return false
    }
    try {
      token = await resolveToken()
    } catch (error) {
      token = ''
      log.warn(`解析 token 失败（按无 token 连接继续）：${redact(error?.message ?? error)}`)
    }
    await connect()
    startHeartbeatWatchdog()
    // 与 qqbot 一致：首次连接失败不算成功，但 started 保持 true —— 让退避重连继续
    return phase === 'connected'
  }

  async function stop() {
    started = false
    clearReconnectTimer()
    if (heartbeatTimer !== null) {
      scope.clearTimer(heartbeatTimer)
      heartbeatTimer = null
    }
    for (const pending of [...pendingCalls.values()]) pending.resolve(null)
    pendingCalls.clear()
    closeSocket(1000, 'stopped')
    setPhase('stopped')
  }

  return {
    kind: 'onebot',
    capabilities: () => capabilities,
    /** 后端画像（OneBot Core 之外的扩展能力探测结果）——诊断与上层降级依据。 */
    backend: () => ({ ...backend, features: { ...backend.features } }),
    start,
    stop,
    status: () => ({
      connected: phase === 'connected',
      phase,
      kind: 'onebot',
      accountId,
      endpoint: redactEndpoint(endpoint),
      wsHost: wsHostOf(endpoint),
      tokenConfigured: token !== '',
      backend: backend.implementation,
      backendVersion: backend.version,
      features: { ...backend.features },
      lastFrameAgoMs: lastFrameAt === 0 ? null : Math.max(0, now() - lastFrameAt),
      lastHeartbeatAgoMs: lastHeartbeatAt === 0 ? null : Math.max(0, now() - lastHeartbeatAt),
      generation,
      pendingCalls: pendingCalls.size,
      attempts: reconnectAttempts,
      lastError,
      pendingRequests: pendingRequests.size,
      sentMessages,
    }),
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onInteraction(handler) {
      // OneBot 没有按钮回调；保留契约槽位，注册即返回解除函数（审批走文本命令）
      interactionHandlers.add(handler)
      return () => interactionHandlers.delete(handler)
    },
    sendText,
    sendMedia,
    sendKeyboard,
    sendTyping,
    downloadMedia,
    /**
     * 机器人资料（昵称）：握手 get_login_info 已经拿到 nickname，这里直接返回，不再请求。
     * 头像是页面按 QQ 号走 qlogo 拼的，所以 avatar 留空。
     * @returns {{id: string, name: string, avatar: string}|null}
     */
    getProfile: () =>
      accountName === '' && accountId === ''
        ? null
        : { id: accountId, name: accountName, avatar: '' },
    recentChat: () => null,

    /**
     * 配置是否齐备（可选 seam）：插件层看门狗用它判断「值不值得再拉一次」，
     * 避免官方凭据存在而 OneBot 缺 wsUrl 时每 5 秒空转。
     * @returns {boolean}
     */
    hasCredentials() {
      return String(settings.wsUrl ?? '').trim() !== ''
    },

    // ── 二期扩展（不属于契约，供 control 层显示/处理请求）──
    /**
     * 登录引导：OneBot 的「QQ 号登录」由 NapCat 负责，插件这边只连 WS。
     * control 的 /qq-login 见到本方法就不再走官方扫码流程（能力探测，不写 kind 判断）。
     * @returns {string}
     */
    loginHint() {
      const status = phase === 'connected' ? 'WS 已连接' : `WS 未连接（${phase}）`
      return [
        '个人 QQ（OneBot/NapCat）的登录在 NapCat 侧完成，本插件不接触 QQ 账密：',
        '  1) 打开 NapCat WebUI（默认 http://127.0.0.1:6099/webui，token 见启动日志或 webui.json）',
        '  2) QQ 登录 → QRCode 扫码（手机 QQ 确认）',
        '  3) 网络配置 → 新建 WebSocket 服务端（正向 WS），端口 3001，messagePostFormat=array，设置 token',
        '  4) 把地址写进插件配置 onebot.wsUrl，token 写进凭据 ONEBOT_ACCESS_TOKEN（或配置 onebot.accessToken）',
        `  当前状态：${status}${endpoint === '' ? '' : `（${redactEndpoint(endpoint)}）`}；改完用 /qq-reconnect 立即重连`,
      ].join('\n')
    },
    /** 待处理的加好友/加群请求（主人可用 /qq-requests 查看）。 */
    requests: () => [...pendingRequests.values()],
    /**
     * 处理一条请求。
     * @param {string} flag
     * @param {boolean} approve
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async resolveRequest(flag, approve) {
      const detail = pendingRequests.get(String(flag))
      if (detail === undefined) return fail(`没有待处理请求：${flag}`)
      if (detail.handled === true) return fail(`该请求已处理过：${flag}`)
      if (now() > detail.expiresAt) {
        pendingRequests.delete(detail.flag)
        return fail(`该请求已过期：${flag}`)
      }
      const action = detail.type === 'group' ? 'set_group_add_request' : 'set_friend_add_request'
      // OneBot 11：群请求必须带 sub_type（add=加群 / invite=邀请），否则实现会拒绝
      const params = {
        flag: detail.flag,
        approve: approve === true,
        ...(detail.type === 'group' && detail.subType !== '' ? { sub_type: detail.subType } : {}),
      }
      detail.handled = true
      const result = await call(action, params)
      if (!result.ok) {
        detail.handled = false // 失败允许重试（结果未知时不重复调用由调用方决定）
        return fail(result.error)
      }
      pendingRequests.delete(detail.flag)
      return ok()
    },

    // 测试/诊断辅助（不属于契约）
    _injectEvent: raw => handleInbound(raw),
    /** 测试钩子：直接走一次 API 调用（验证分类/超时语义），不属于契约。 */
    _call: (action, params = {}) => call(action, params),
    /** 测试钩子：改写 token（模拟用户改对 token 后 /qq-reconnect）。 */
    _setTokenForTest: value => {
      tokenOverride = String(value ?? '')
      token = tokenOverride
    },
    _state: () => ({
      phase,
      accountId,
      endpoint: redactEndpoint(endpoint),
      reconnectAttempts,
      pendingCalls: pendingCalls.size,
      recentMessages: recentMessages.size,
      pendingRequests: pendingRequests.size,
      sentMessages,
      hasToken: token !== '',
    }),
    _resolveToken: resolveToken,
  }
}

export default createTransport
