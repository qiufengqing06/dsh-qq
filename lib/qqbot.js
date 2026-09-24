/**
 * QQBot transport —— 官方 QQ 机器人 API v2 实现（执行文档 §1.3 行为参照、§5.6 契约）。
 *
 * 覆盖 P1 范围：凭据解析 → access token（singleflight + 提前续期）→ 网关地址 →
 * WebSocket（hello/identify/resume/heartbeat）→ 断线重连（退避 + close code 语义）→
 * 私聊/群 @/频道消息归一化 → 文本回发（分段 + msg_seq + 被动回复）。
 *
 * 设计约束：
 *   - 零第三方依赖：HTTP 用内置 fetch，WS 用 Node ≥22 内置 WebSocket；
 *     需要代理时（P6）再动态加载 ws + https-proxy-agent。
 *   - 所有运行时资源挂 ResourceScope，stop()/dispose 一次性释放（心跳、重连定时器、socket）。
 *   - 凭据只从 credentials 服务 / 环境读取，永不写日志（脱敏见 redact）。
 */

import { buildChatKey, chunkText, makeCapabilities, makeInboundEvent, MAX_MESSAGE_LENGTH } from './transport.js'
import { resolveCredentials } from './config.js'
import { chunkedUpload } from './upload.js'

// 凭据解析统一由 config.js 拥有（读写同源）；这里转出以保持模块既有表面。
export { resolveCredentials }

/** 官方 API 常量（与 Hermes gateway/platforms/qqbot/constants.py 对齐）。 */
export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
export const API_BASE = 'https://api.sgroup.qq.com'
export const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
export const SANDBOX_PORTAL_HOST = 'sandbox.q.qq.com'

/** intents：C2C_GROUP_AT_MESSAGES + PUBLIC_GUILD_MESSAGES + DIRECT_MESSAGE + INTERACTION。 */
export const INTENTS = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26)


export const DEFAULT_HEARTBEAT_MS = 30_000
export const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000]
export const MAX_RECONNECT_ATTEMPTS = 100
export const RATE_LIMIT_DELAY_MS = 60_000
export const QUICK_DISCONNECT_MS = 5_000
export const MAX_QUICK_DISCONNECTS = 3
export const DEDUP_WINDOW_MS = 300_000
export const DEDUP_MAX_SIZE = 1_000
export const API_TIMEOUT_MS = 30_000
export const TOKEN_EARLY_REFRESH_MS = 60_000
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000
/** 内联 base64 上传上限（QQ 平台 ~10MB）；更大文件走分片上传（P6）。 */
export const INLINE_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024

/** media.kind → QQ file_type。 */
export const FILE_TYPES = Object.freeze({ image: 1, video: 2, audio: 3, voice: 3, file: 4 })

/** 致命 close code：重连无意义（Hermes _listen_loop L601-621）。 */
export const FATAL_CLOSE_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])
/** 会话失效 close code：清 session/seq 后重新 identify。 */
export const SESSION_RESET_CLOSE_CODES = new Set([
  4006, 4007, 4900, 4901, 4902, 4903, 4904, 4905, 4906, 4907, 4908, 4909, 4910, 4911, 4912, 4913,
])

const MESSAGE_EVENTS = new Set([
  'C2C_MESSAGE_CREATE',
  'GROUP_AT_MESSAGE_CREATE',
  'GUILD_MESSAGE_CREATE',
  'GUILD_AT_MESSAGE_CREATE',
  'DIRECT_MESSAGE_CREATE',
])

const ok = (extra = {}) => ({ ok: true, ...extra })
const fail = (error, extra = {}) => ({ ok: false, error: String(error), ...extra })

/** 代理 URL 脱敏：抹掉 userinfo（proxy 密码绝不进日志/状态）。 */
export function redactProxy(url) {
  const text = String(url ?? '')
  if (text === '') return ''
  return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@')
}

/** 脱敏：日志/错误里绝不出现 secret/token。 */
export function redact(value) {
  const text = String(value ?? '')
  return text
    .replace(/(client_?secret|secret|token|access_token)"?\s*[:=]\s*"?[A-Za-z0-9._-]+/gi, '$1=***')
    .replace(/QQBot\s+[A-Za-z0-9._-]+/g, 'QQBot ***')
}

/** 时间戳解析：QQ 的 timestamp 既可能是 ISO 字符串也可能是秒/毫秒数字。 */
export function parseTimestamp(raw) {
  if (raw === undefined || raw === null || raw === '') return Date.now()
  const text = String(raw)
  if (/^\d+$/.test(text)) {
    const num = Number(text)
    return num < 1e12 ? num * 1000 : num
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

/** 按 content_type 判断媒体种类。 */
export function mediaKindOf(contentType, filename = '') {
  const type = String(contentType ?? '').toLowerCase()
  const name = String(filename ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/') || type.includes('silk') || name.endsWith('.silk') || name.endsWith('.amr')) return 'audio'
  return 'file'
}



/** msg_seq：QQ 要求的消息序号（0..65535）。 */
export function nextMsgSeq(previous = 0) {
  return (previous + 1) % 65_536
}

/**
 * 构造 InlineKeyboard（对齐 Hermes keyboards.py 的 InlineKeyboard/Row/Button 结构）。
 * @param {Array<{label: string, data: string, visitedLabel?: string, style?: 0|1}>} buttons
 * @param {object} [options]
 * @param {string} [options.groupId] - 同组按钮互斥（点击一个其余置灰）。
 * @returns {{content: {rows: Array<{buttons: Array<object>}>}}}
 */
export function buildKeyboard(buttons, { groupId = 'approval' } = {}) {
  const row = {
    buttons: buttons.map((button, index) => ({
      id: `btn-${index + 1}`,
      render_data: {
        label: String(button.label ?? `按钮${index + 1}`),
        visited_label: String(button.visitedLabel ?? button.label ?? `按钮${index + 1}`),
        style: button.style === 0 ? 0 : 1,
      },
      action: {
        type: 2, // 2 = 回调（触发 INTERACTION_CREATE）；1 = 链接。与 QQ 文档一致
        data: String(button.data ?? ''),
        permission: { type: 2 }, // 2 = 所有人可点
        click_limit: 1,
      },
      group_id: groupId,
    })),
  }
  return { content: { rows: [row] } }
}

/**
 * 从 QQ 原始 dispatch 构造归一化入站事件。
 * @param {string} type - dispatch 事件名。
 * @param {object} d - 事件数据。
 * @param {string} accountId - AppID（chatKey 命名空间）。
 * @returns {object|null} 归一化事件（不认识的形状返回 null）
 */
export function normalizeDispatch(type, d, accountId) {
  if (d === null || typeof d !== 'object') return null
  const base = { transportKind: 'qqbot', accountId }
  const author = d.author !== null && typeof d.author === 'object' ? d.author : {}
  const rawAttachments = Array.isArray(d.attachments) ? d.attachments : []
  const media = rawAttachments
    .filter(item => item !== null && typeof item === 'object')
    .map(item => ({
      kind: mediaKindOf(item.content_type, item.filename),
      url: String(item.url ?? ''),
      ...(item.filename === undefined ? {} : { fileName: String(item.filename) }),
      ...(item.content_type === undefined ? {} : { mime: String(item.content_type) }),
      ...(item.size === undefined ? {} : { size: Number(item.size) || 0 }),
      // QQ 语音消息自带腾讯 ASR 文本（免费、优先使用，省掉外部 STT 调用）
      ...(item.asr_refer_text === undefined || item.asr_refer_text === null || item.asr_refer_text === ''
        ? {}
        : { asrText: String(item.asr_refer_text) }),
    }))
    .filter(item => item.url !== '')

  const common = {
    ...base,
    messageId: String(d.id ?? ''),
    timestamp: parseTimestamp(d.timestamp),
    text: String(d.content ?? ''),
    media,
    rawKind: type,
  }

  if (type === 'C2C_MESSAGE_CREATE') {
    const userId = String(author.user_openid ?? '')
    if (userId === '') return null
    return makeInboundEvent({
      ...common,
      target: { kind: 'dm', userId },
      sender: { id: userId, name: String(author.username ?? '') },
      mentioned: true,
    })
  }
  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    const groupId = String(d.group_openid ?? '')
    if (groupId === '') return null
    return makeInboundEvent({
      ...common,
      target: { kind: 'group', groupId },
      sender: { id: String(author.member_openid ?? ''), name: String(author.username ?? '') },
      mentioned: true,
    })
  }
  if (type === 'GUILD_MESSAGE_CREATE' || type === 'GUILD_AT_MESSAGE_CREATE' || type === 'DIRECT_MESSAGE_CREATE') {
    const guildId = String(d.guild_id ?? '')
    const channelId = String(d.channel_id ?? '')
    if (guildId === '' || channelId === '') return null
    return makeInboundEvent({
      ...common,
      target: { kind: 'channel', guildId, channelId },
      sender: { id: String(author.id ?? ''), name: String(author.username ?? '') },
      mentioned: type !== 'GUILD_MESSAGE_CREATE',
    })
  }
  return null
}

/** 从 INTERACTION_CREATE 提取按钮回调与来源 target。 */
export function normalizeInteraction(d, accountId) {
  if (d === null || typeof d !== 'object') return null
  const data = d.data !== null && typeof d.data === 'object' ? d.data : {}
  const resolved = data.resolved !== null && typeof data.resolved === 'object' ? data.resolved : {}
  const buttonData = String(data.button_data ?? '')
  const chatType = Number(d.chat_type)
  let target = null
  if (chatType === 2 || d.user_openid) {
    const userId = String(d.user_openid ?? resolved.user_id ?? '')
    if (userId !== '') target = { kind: 'dm', userId }
  } else if (chatType === 1 || d.group_openid) {
    const groupId = String(d.group_openid ?? resolved.group_id ?? '')
    if (groupId !== '') target = { kind: 'group', groupId }
  } else if (d.channel_id) {
    target = { kind: 'channel', guildId: String(d.guild_id ?? ''), channelId: String(d.channel_id) }
  }
  if (target === null) return null
  return {
    id: String(d.id ?? ''),
    data: buttonData,
    target,
    sender: { id: String(resolved.user_id ?? d.user_openid ?? ''), name: '' },
    transportKind: 'qqbot',
    accountId,
  }
}

/**
 * 创建 QQBot transport。
 * @param {object} spec
 * @param {object} spec.config - resolveConfig 结果。
 * @param {object} spec.ctx - Cordis 上下文（credentials 等可选服务）。
 * @param {object} [spec.logger]
 * @param {object} spec.scope - ResourceScope。
 * @param {object} [spec.deps] - 测试注入：fetchImpl / socketFactory / clock / backoffMs / maxReconnectAttempts。
 * @returns {object} transport（transport 契约）
 */
export function createTransport({ config, ctx, logger = null, scope, deps = {} }) {
  if (scope === undefined || scope === null) throw new TypeError('qqbot transport requires a ResourceScope')
  const proxyProvider = deps.proxyUrl !== undefined ? () => String(deps.proxyUrl ?? '') : () => resolveProxyUrl()
  const fetchImpl =
    deps.fetchImpl ??
    createFetchImpl({ proxyProvider, dispatcherLoader: deps.dispatcherLoader, logger: deps.logger ?? logger })
  const socketFactory =
    deps.socketFactory ??
    createSocketFactory({ proxyLoader: deps.proxyLoader, logger: deps.logger ?? logger })
  const backoffMs = Array.isArray(deps.backoffMs) ? deps.backoffMs : RECONNECT_BACKOFF_MS
  const maxReconnectAttempts = Number.isSafeInteger(deps.maxReconnectAttempts)
    ? deps.maxReconnectAttempts
    : MAX_RECONNECT_ATTEMPTS
  const sandbox = String(config.portalHost ?? '') === SANDBOX_PORTAL_HOST
  const apiBase = deps.apiBase ?? (sandbox ? SANDBOX_API_BASE : API_BASE)
  const tokenUrl = deps.tokenUrl ?? TOKEN_URL

  // 插件卸载/热重载时必须断开长连接：只清定时器不关 socket，
  // 旧实例会继续收事件，导致消息被处理两遍。
  scope.add(() => stop(), 'qqbot socket')

  const messageHandlers = new Set()
  const interactionHandlers = new Set()
  const capabilities = makeCapabilities({
    // 文本 markdown、INPUT_NOTIFY、审批 InlineKeyboard 与媒体收发均已实现；大文件分片上传 P6。
    markdown: true,
    keyboard: true,
    typing: true,
    passiveReply: true,
    proactiveMessage: true,
    media: ['image', 'file', 'audio', 'video'],
  })

  const log = {
    info: message => {
      try {
        logger?.info?.(`[qqbot] ${message}`)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(`[qqbot] ${message}`)
      } catch {
        /* ignore */
      }
    },
  }

  let phase = 'idle'
  let lastError = ''
  let accountId = String(config.accountId ?? '')
  let credentials = null
  let accessToken = ''
  let tokenExpiresAt = 0
  let tokenPromise = null
  let socket = null
  let sessionId = ''
  let lastSeq = null
  let heartbeatMs = DEFAULT_HEARTBEAT_MS
  let heartbeatTimer = null
  let reconnectTimer = null
  let reconnectAttempts = 0
  let connecting = false
  let started = false
  let lastConnectAt = 0
  let quickDisconnects = 0
  let msgSeq = 0
  const seenMessages = new Map()
  /** chatKey → 最近一条入站消息 id（被动回复窗口用） */
  /** 每个 chat 最近一条入站消息：{ id, at }。at 用于判断被动回复窗口是否还在。 */
  /** 时基：deps.now 供测试注入（引用窗口/去重都依赖它）。 */
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  /** 被动回复转主动消息的次数（诊断与测试用）。 */
  let passiveFallbacks = 0
  const lastMessageIds = new Map()

  const setPhase = (next, error = '') => {
    phase = next
    if (error !== '') lastError = error
  }

  // ── token ──────────────────────────────────────────────────────────
  async function ensureToken({ force = false } = {}) {
    if (!force && accessToken !== '' && Date.now() < tokenExpiresAt - TOKEN_EARLY_REFRESH_MS) {
      return accessToken
    }
    if (tokenPromise !== null) return tokenPromise // singleflight
    tokenPromise = (async () => {
      const response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.clientSecret }),
        signal: timeoutSignal(API_TIMEOUT_MS),
      })
      const data = await readJson(response)
      if (!response.ok) throw new Error(`token HTTP ${response.status}: ${redact(JSON.stringify(data))}`)
      const token = data?.access_token
      if (typeof token !== 'string' || token === '') throw new Error('token 响应缺少 access_token')
      accessToken = token
      const expiresIn = Number(data?.expires_in ?? 7200)
      tokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200) * 1000
      return accessToken
    })().finally(() => {
      tokenPromise = null
    })
    return tokenPromise
  }

  async function fetchGatewayUrl() {
    const token = await ensureToken()
    const response = await fetchImpl(`${apiBase}/gateway`, {
      method: 'GET',
      headers: authHeaders(token),
      signal: timeoutSignal(API_TIMEOUT_MS),
    })
    const data = await readJson(response)
    if (!response.ok) throw new Error(`gateway HTTP ${response.status}: ${redact(JSON.stringify(data))}`)
    const url = data?.url
    if (typeof url !== 'string' || url === '') throw new Error('gateway 响应缺少 url')
    return url
  }

  // ── websocket ──────────────────────────────────────────────────────
  async function connect() {
    if (connecting || !started || scope.disposed) return
    connecting = true
    clearReconnectTimer()
    try {
      setPhase(reconnectAttempts === 0 ? 'connecting' : 'reconnecting')
      const url = await fetchGatewayUrl()
      if (!started || scope.disposed) return
      const raw = await socketFactory(url, { proxyUrl: proxyProvider() })
      if (!started || scope.disposed) {
        closeSocket(raw, 1000, 'stopped')
        return
      }
      socket = raw
      lastConnectAt = Date.now()
      attachSocket(raw, {
        onOpen: () => log.info('WebSocket 已连接'),
        onMessage: payload => handlePayload(payload),
        onClose: (code, reason) => handleClose(code, reason),
        onError: error => log.warn(`WebSocket 错误：${redact(error?.message ?? error)}`),
      })
    } catch (error) {
      lastError = redact(error?.message ?? error)
      log.warn(`连接失败：${lastError}`)
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }

  function handlePayload(rawPayload) {
    const payload = typeof rawPayload === 'string' ? safeParse(rawPayload) : rawPayload
    if (payload === null || typeof payload !== 'object') return
    const { op, t, s, d } = payload
    if (typeof s === 'number' && (lastSeq === null || s > lastSeq)) lastSeq = s

    if (op === 10) {
      const interval = Number(d?.heartbeat_interval ?? DEFAULT_HEARTBEAT_MS)
      heartbeatMs = Number.isFinite(interval) && interval > 0 ? Math.max(100, Math.floor(interval * 0.8)) : DEFAULT_HEARTBEAT_MS
      reconnectAttempts = 0
      setPhase('connected')
      if (sessionId !== '' && lastSeq !== null) void sendResume()
      else void sendIdentify()
      return
    }
    if (op === 0) {
      if (t === 'READY') {
        sessionId = String(d?.session_id ?? '')
        setPhase('connected')
        log.info('已就绪（READY）')
        return
      }
      if (t === 'RESUMED') {
        setPhase('connected')
        log.info('会话已恢复（RESUMED）')
        return
      }
      if (typeof t === 'string' && MESSAGE_EVENTS.has(t)) {
        void handleInbound(t, d)
        return
      }
      if (t === 'INTERACTION_CREATE') {
        // 必须尽快 ACK（PUT /interactions/{id}），否则用户端按钮显示错误态
        const interactionId = String(d?.id ?? '')
        if (interactionId !== '') void acknowledgeInteraction(interactionId)
        const interaction = normalizeInteraction(d, accountId)
        if (interaction !== null) {
          for (const handler of [...interactionHandlers]) {
            try {
              const result = handler(interaction)
              if (result !== undefined && typeof result.then === 'function') result.catch(() => {})
            } catch (error) {
              log.warn(`交互回调失败：${redact(error?.message ?? error)}`)
            }
          }
        }
        return
      }
      return
    }
    if (op === 7) {
      log.info('服务端要求重连（op 7）')
      closeSocket(socket, 4000, 'server requested reconnect')
      return
    }
    if (op === 9) {
      if (d !== true) {
        sessionId = ''
        lastSeq = null
      }
      closeSocket(socket, 4001, 'invalid session')
      return
    }
    // op 11 heartbeat ACK / 其他：忽略
  }

  async function sendIdentify() {
    const token = await ensureToken()
    sendFrame({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: Number.isSafeInteger(deps.intents) ? deps.intents : INTENTS,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-qq', $device: 'dsh-qq' },
      },
    })
    startHeartbeat()
    log.info('已发送 Identify')
  }

  async function sendResume() {
    const token = await ensureToken()
    sendFrame({ op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } })
    startHeartbeat()
    log.info('已发送 Resume')
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = scope.timer(() => sendFrame({ op: 1, d: lastSeq }), heartbeatMs, {
      repeat: true,
      label: 'qqbot heartbeat',
    })
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) scope.clearTimer(heartbeatTimer)
    heartbeatTimer = null
  }

  function sendFrame(payload) {
    if (socket === null) return false
    try {
      socketSend(socket, JSON.stringify(payload))
      return true
    } catch (error) {
      log.warn(`发送帧失败：${redact(error?.message ?? error)}`)
      return false
    }
  }

  function handleClose(code, reason) {
    stopHeartbeat()
    socket = null
    if (!started || scope.disposed) return
    log.warn(`WebSocket 关闭：code=${code} reason=${redact(reason)}`)
    if (FATAL_CLOSE_CODES.has(code)) {
      setPhase('fatal', `致命 close code ${code}（检查机器人权限/沙箱状态）`)
      return
    }
    const lifetime = Date.now() - lastConnectAt
    if (lastConnectAt > 0 && lifetime < QUICK_DISCONNECT_MS) {
      quickDisconnects += 1
      if (quickDisconnects >= MAX_QUICK_DISCONNECTS) {
        setPhase('fatal', '连续快速断开——请检查 AppID/AppSecret 与机器人权限')
        return
      }
    } else {
      quickDisconnects = 0
    }
    if (code === 4004) {
      accessToken = ''
      tokenExpiresAt = 0
      log.info('token 失效（4004），将刷新后重连')
    }
    if (SESSION_RESET_CLOSE_CODES.has(code)) {
      sessionId = ''
      lastSeq = null
    }
    scheduleReconnect(code === 4008 ? RATE_LIMIT_DELAY_MS : null)
  }

  function scheduleReconnect(forcedDelay = null) {
    if (!started || scope.disposed) return
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
        void connect()
      },
      delay,
      { label: 'qqbot reconnect' },
    )
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) scope.clearTimer(reconnectTimer)
    reconnectTimer = null
  }

  // ── inbound ────────────────────────────────────────────────────────
  async function handleInbound(type, d) {
    const event = normalizeDispatch(type, d, accountId)
    if (event === null) return
    if (event.messageId !== '' && isDuplicate(event.messageId)) {
      log.info(`忽略重复消息 ${event.messageId}`)
      return
    }
    if (event.messageId !== '') lastMessageIds.set(event.chatKey, { id: event.messageId, at: now() })
    for (const handler of [...messageHandlers]) {
      try {
        const result = handler(event)
        if (result !== undefined && typeof result.then === 'function') await result
      } catch (error) {
        log.warn(`入站处理失败：${redact(error?.message ?? error)}`)
      }
    }
  }

  function isDuplicate(messageId) {
    const at = now()
    const windowMs = config.dedupWindowMs
    const maxSize = config.dedupMaxSize
    const seen = seenMessages.get(messageId)
    if (seen !== undefined && at - seen < windowMs) return true
    seenMessages.set(messageId, at)
    if (seenMessages.size > maxSize) {
      for (const [key, time] of seenMessages) {
        if (at - time >= windowMs) seenMessages.delete(key)
      }
      while (seenMessages.size > maxSize) {
        const oldest = seenMessages.keys().next().value
        seenMessages.delete(oldest)
      }
    }
    return false
  }

  // ── outbound ───────────────────────────────────────────────────────
  /**
   * 被动回复引用：只有在 QQ 的被动回复窗口（config.replyWindowMs，默认 5 分钟）内才带 msg_id。
   * 超窗后必须按主动消息发（官方会拒：err_code 40034005「回复消息msg_id已过期」）。
   * @param {object} target - 结构化 target
   * @param {string} [explicit] - 调用方显式指定的引用（优先）
   * @returns {string} msg_id，或 ''（不引用）
   */
  function passiveReference(target, explicit = '') {
    if (explicit !== '') return explicit
    // 还没登录（accountId 未知）就不可能有引用：buildChatKey 会拒绝空账号名
    if (accountId === '') return ''
    const entry = lastMessageIds.get(buildChatKey('qqbot', accountId, target))
    if (entry === undefined) return ''
    if (now() - entry.at > config.replyWindowMs) return ''
    return entry.id
  }

  /** 引用失效类错误：msg_id 过期/错误，以及「非 At 当前用户的消息不允许回复」。 */
  const REFERENCE_ERROR_CODES = new Set([40034005, 304026, 304027, 304028])

  function isReferenceFailure(result) {
    const code = Number(result?.code ?? 0)
    if (REFERENCE_ERROR_CODES.has(code)) return true
    const text = String(result?.error ?? '')
    return /msg_id|MSG_EXPIRE|已过期|不允许回复/.test(text)
  }

  /**
   * 发消息 + 引用失效兜底：QQ 的被动回复窗口过了（或引用非法）时，去掉 msg_id 与
   * message_reference 重发一次（转主动消息）。否则长回合（>5 分钟）的回复会静默丢失。
   * @param {string} path - 目标 REST 路径
   * @param {object} body - 消息体
   * @param {string} reference - 本次携带的引用（空 = 本来就没引用）
   * @returns {Promise<object>} apiRequest 结果
   */
  async function postMessage(path, body, reference) {
    const first = await apiRequest('POST', path, body)
    if (first.ok || reference === '' || !isReferenceFailure(first)) return first
    passiveFallbacks += 1
    log.warn(`被动回复引用失效（${redact(first.error)}），去掉引用改为主动消息重发`)
    const { msg_id: _msgId, message_reference: _ref, ...rest } = body
    return apiRequest('POST', path, rest)
  }

  function messagePath(target) {
    if (target.kind === 'dm') return `/v2/users/${target.userId}/messages`
    if (target.kind === 'group') return `/v2/groups/${target.groupId}/messages`
    return `/channels/${target.channelId}/messages`
  }

  async function apiRequest(method, path, body) {
    if (phase !== 'connected' && phase !== 'connecting') {
      return fail('QQ 未连接（请检查凭据与网关状态）', { retryable: true })
    }
    const token = await ensureToken()
    let response
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: timeoutSignal(API_TIMEOUT_MS),
      })
    } catch (error) {
      return fail(`请求失败：${redact(error?.message ?? error)}`, { retryable: true })
    }
    const data = await readJson(response)
    if (!response.ok) {
      const status = response.status
      const code = Number(data?.code ?? data?.err_code ?? 0)
      return fail(`API ${status} ${redact(JSON.stringify(data ?? {}))}`, {
        retryable: status >= 500 || status === 429,
        status,
        ...(Number.isFinite(code) && code !== 0 ? { code } : {}),
      })
    }
    return ok({ raw: data, messageId: String(data?.id ?? '') })
  }

  async function sendText(target, text, opts = {}) {
    const content = String(text ?? '')
    if (content.trim() === '') return ok()
    const useMarkdown = opts.markdown === true && target.kind !== 'channel'
    const chunks = chunkText(content)
    const replyTo = passiveReference(target, typeof opts.replyTo === 'string' ? opts.replyTo : '')
    let last = ok()
    for (const [index, chunk] of chunks.entries()) {
      msgSeq = nextMsgSeq(msgSeq)
      // 被动回复用 msg_id（官方 v2 C2C/群聊的回复字段）；message_reference 是频道引用展示，
      // C2C/群聊同时带上与 Hermes 生产实现一致，且不影响 msg_id 的被动语义。
      const body =
        target.kind === 'channel'
          ? {
              content: chunk.slice(0, MAX_MESSAGE_LENGTH),
              ...(replyTo === '' ? {} : { msg_id: replyTo }),
            }
          : useMarkdown
            ? {
                markdown: { content: chunk.slice(0, MAX_MESSAGE_LENGTH) },
                msg_type: 2,
                msg_seq: msgSeq,
                ...(index === 0 && replyTo !== '' ? { msg_id: replyTo } : {}),
              }
            : {
                content: chunk.slice(0, MAX_MESSAGE_LENGTH),
                msg_type: 0,
                msg_seq: msgSeq,
                ...(index === 0 && replyTo !== ''
                  ? { msg_id: replyTo, message_reference: { message_id: replyTo } }
                  : {}),
              }
      last = await postMessage(messagePath(target), body, index === 0 ? replyTo : '')
      if (!last.ok) return last
    }
    return last
  }

  async function sendTyping(target, opts = {}) {
    if (target.kind === 'channel') return fail('频道不支持输入中指示')
    msgSeq = nextMsgSeq(msgSeq)
    const replyTo = passiveReference(target, typeof opts.replyTo === 'string' ? opts.replyTo : '')
    const body = { msg_type: 6, msg_seq: msgSeq, ...(replyTo === '' ? {} : { msg_id: replyTo }) }
    return postMessage(messagePath(target), body, replyTo)
  }

  /** 交互 ACK：按钮点击必须尽快确认（PUT /interactions/{id} {code:0}）。 */
  async function acknowledgeInteraction(interactionId) {
    const result = await apiRequest('PUT', `/interactions/${interactionId}`, { code: 0 })
    if (!result.ok) log.warn(`交互 ACK 失败（${interactionId}）：${result.error}`)
    return result
  }

  /** 带 InlineKeyboard 的消息（审批按钮）。 */
  async function sendKeyboard(target, text, buttons, opts = {}) {
    if (!Array.isArray(buttons) || buttons.length === 0) return fail('sendKeyboard 需要至少一个按钮')
    const content = String(text ?? '').slice(0, MAX_MESSAGE_LENGTH)
    const keyboard = buildKeyboard(buttons)
    const replyTo = passiveReference(target, typeof opts.replyTo === 'string' ? opts.replyTo : '')
    msgSeq = nextMsgSeq(msgSeq)
    const body =
      target.kind === 'channel'
        ? { content, keyboard, ...(replyTo === '' ? {} : { msg_id: replyTo }) }
        : { content, msg_type: 0, msg_seq: msgSeq, keyboard, ...(replyTo === '' ? {} : { msg_id: replyTo }) }
    return postMessage(messagePath(target), body, replyTo)
  }

  /**
   * 下载 QQ 媒体（消息附件需带 `Authorization: QQBot <token>`）。
   * @param {string} url
   * @param {object} [opts]
   * @param {number} [opts.maxBytes]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ok: boolean, data?: Buffer, contentType?: string, bytes?: number, error?: string}>}
   */
  async function downloadMedia(url, { maxBytes = config.maxFileBytes, signal = undefined } = {}) {
    if (typeof url !== 'string' || url === '') return fail('downloadMedia 需要 url')
    if (phase !== 'connected' && phase !== 'connecting') return fail('QQ 未连接', { retryable: true })
    const token = await ensureToken()
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: authHeaders(token),
        signal: signal ?? timeoutSignal(MEDIA_DOWNLOAD_TIMEOUT_MS),
      })
    } catch (error) {
      return fail(`媒体下载失败：${redact(error?.message ?? error)}`, { retryable: true })
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
      return fail(`媒体读取失败：${redact(error?.message ?? error)}`, { retryable: true })
    }
    if (data.byteLength > maxBytes) return fail(`媒体超过上限（${data.byteLength} > ${maxBytes} 字节）`)
    return ok({
      data,
      bytes: data.byteLength,
      contentType: String(response.headers?.get?.('content-type') ?? ''),
    })
  }

  /**
   * 发送媒体：先上传取 file_info，再发 msg_type=7 消息。
   * 支持 url（平台代抓）/ base64 / path（本地文件，≤10MB 内联）。
   * @param {object} target
   * @param {{kind: string, url?: string, base64?: string, path?: string, fileName?: string, caption?: string}} media
   * @param {object} [opts]
   */
  async function sendMedia(target, media, opts = {}) {
    if (target.kind === 'channel') return fail('频道不支持媒体上传（QQ 平台限制）')
    if (media === null || typeof media !== 'object') return fail('sendMedia 需要 media 对象')
    const fileType = FILE_TYPES[media.kind]
    if (fileType === undefined) return fail(`不支持的媒体类型 ${JSON.stringify(media.kind)}`)

    let fileName = typeof media.fileName === 'string' ? media.fileName : ''
    let fileInfo = ''
    const targetKind = target.kind === 'dm' ? 'dm' : 'group'
    const targetId = target.kind === 'dm' ? target.userId : target.groupId

    if (typeof media.url === 'string' && media.url !== '') {
      // URL 来源：平台代抓
      const uploaded = await apiRequest('POST', `${targetKind === 'dm' ? '/v2/users' : '/v2/groups'}/${targetId}/files`, {
        file_type: fileType,
        srv_send_msg: false,
        url: media.url,
        ...(fileType === FILE_TYPES.file && fileName !== '' ? { file_name: fileName } : {}),
      })
      if (!uploaded.ok) return uploaded
      fileInfo = uploaded.raw?.file_info ?? uploaded.raw?.data?.file_info ?? ''
    } else {
      // base64 / 本地路径：先取字节，再决定内联 or 分片
      let bytes = null
      if (typeof media.base64 === 'string' && media.base64 !== '') {
        bytes = Buffer.from(media.base64, 'base64')
      } else if (typeof media.path === 'string' && media.path !== '') {
        try {
          const { readFile } = await import('node:fs/promises')
          bytes = await readFile(media.path)
          if (fileName === '') fileName = String(media.path).split('/').pop() ?? ''
        } catch (error) {
          return fail(`读取本地文件失败：${redact(error?.message ?? error)}`)
        }
      }
      if (bytes === null || bytes.byteLength === 0) return fail('sendMedia 需要 url / base64 / path 之一')

      if (bytes.byteLength <= INLINE_UPLOAD_LIMIT_BYTES) {
        const uploaded = await apiRequest('POST', `${targetKind === 'dm' ? '/v2/users' : '/v2/groups'}/${targetId}/files`, {
          file_type: fileType,
          srv_send_msg: false,
          file_data: bytes.toString('base64'),
          ...(fileType === FILE_TYPES.file && fileName !== '' ? { file_name: fileName } : {}),
        })
        if (!uploaded.ok) return uploaded
        fileInfo = uploaded.raw?.file_info ?? uploaded.raw?.data?.file_info ?? ''
      } else {
        // 大文件：分片上传（P6）
        const uploaded = await chunkedUpload({
          data: bytes,
          fileName: fileName === '' ? 'upload.bin' : fileName,
          fileType,
          targetKind,
          targetId,
          apiRequest,
          fetchImpl,
          logger,
          signal: scope.signal,
        })
        if (uploaded.ok !== true) return fail(`分片上传失败：${uploaded.error}`)
        fileInfo = uploaded.fileInfo
      }
    }

    if (fileInfo === '') return fail('上传未返回 file_info')

    msgSeq = nextMsgSeq(msgSeq)
    const caption = typeof media.caption === 'string' ? media.caption : typeof opts.caption === 'string' ? opts.caption : ''
    const replyTo = passiveReference(target, typeof opts.replyTo === 'string' ? opts.replyTo : '')
    const body = {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: msgSeq,
      ...(caption === '' ? {} : { content: caption.slice(0, MAX_MESSAGE_LENGTH) }),
      ...(replyTo === '' ? {} : { msg_id: replyTo }),
    }
    return postMessage(messagePath(target), body, replyTo)
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  async function start() {
    if (started) return true
    started = true
    credentials = await resolveCredentials(ctx)
    if (credentials === null) {
      // 允许后续再次 start：启动期 credentials 服务可能已发布但文档尚未加载完，
      // 由插件层看门狗（lib/index.js）或 /qq-reconnect 再次调用即可连上。
      started = false
      setPhase('no-credentials', '缺少 QQ_APP_ID / QQ_CLIENT_SECRET（请在设置/凭据里配置）')
      log.warn('未配置凭据，transport 保持未连接')
      return false
    }
    accountId = credentials.appId
    log.info(`使用 ${credentials.source} 中的凭据（AppID ${accountId}）`)
    await connect()
    // 首次连接失败即返回 false（后台仍会按退避重连）；只有真正建立/正在建立连接才算成功
    return phase === 'connected' || phase === 'connecting'
  }

  async function stop() {
    started = false
    clearReconnectTimer()
    stopHeartbeat()
    const current = socket
    socket = null
    if (current !== null) closeSocket(current, 1000, 'stopped')
    setPhase('stopped')
  }

  return {
    kind: 'qqbot',
    capabilities: () => capabilities,
    start,
    stop,
    status: () => ({
      connected: phase === 'connected',
      phase,
      kind: 'qqbot',
      accountId,
      sandbox,
      sessionId: sessionId === '' ? '' : 'active',
      attempts: reconnectAttempts,
      lastError,
      proxy: proxyProvider() === '' ? '' : redactProxy(proxyProvider()),
    }),
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onInteraction(handler) {
      interactionHandlers.add(handler)
      return () => interactionHandlers.delete(handler)
    },
    sendText,
    sendMedia,
    sendKeyboard,
    sendTyping,
    downloadMedia,
    recentChat: () => null,

    // 测试/诊断辅助（不属于契约）
    _injectPayload: payload => handlePayload(payload),
    _acknowledgeInteraction: acknowledgeInteraction,
    _state: () => ({
      phase,
      sessionId,
      lastSeq,
      heartbeatMs,
      reconnectAttempts,
      seen: seenMessages.size,
      accountId,
      passiveFallbacks,
    }),
    _credentials: () => (credentials === null ? null : { appId: credentials.appId, source: credentials.source }),
    _reloadCredentials: async () => {
      credentials = await resolveCredentials(ctx)
      return credentials === null ? null : { appId: credentials.appId, source: credentials.source }
    },
  }
}

/** 统一 socket 事件绑定（兼容 Node WebSocket 的 addEventListener 与 ws 的 on）。 */
function attachSocket(socket, handlers) {
  attach(socket, 'open', () => handlers.onOpen?.())
  attach(socket, 'message', payload => handlers.onMessage?.(extractData(payload)))
  attach(socket, 'close', (first, second) => {
    // 浏览器风格：CloseEvent{code, reason}；ws 风格：close(code, reason)
    const isEvent = first !== null && typeof first === 'object'
    const code = isEvent ? first.code : first
    const reason = isEvent ? first.reason : second
    handlers.onClose?.(Number(code ?? 1006), reasonText(reason))
  })
  attach(socket, 'error', error => handlers.onError?.(error))
}

function attach(socket, event, listener) {
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(event, listener)
    return
  }
  if (typeof socket?.on === 'function') {
    socket.on(event, listener)
    return
  }
  throw new TypeError(`socket 不支持事件绑定（缺少 addEventListener/on）`)
}

function detach(socket, event, listener) {
  if (typeof socket?.removeEventListener === 'function') socket.removeEventListener(event, listener)
  else if (typeof socket?.off === 'function') socket.off(event, listener)
}

function extractData(payload) {
  if (payload !== null && typeof payload === 'object' && 'data' in payload) return payload.data
  return payload
}

function reasonText(reason) {
  if (reason === undefined || reason === null) return ''
  if (typeof reason === 'string') return reason
  if (reason instanceof Uint8Array || Buffer.isBuffer(reason)) return Buffer.from(reason).toString('utf8')
  if (typeof reason?.toString === 'function') return reason.toString()
  return ''
}

function socketSend(socket, text) {
  if (typeof socket?.send === 'function') return socket.send(text)
  throw new TypeError('socket 不支持 send')
}

function closeSocket(socket, code, reason) {
  if (socket === null) return
  try {
    if (typeof socket.close === 'function') socket.close(code, reason)
  } catch {
    /* ignore */
  }
}

function authHeaders(token) {
  return {
    Authorization: `QQBot ${token}`,
    Accept: 'application/json',
    'User-Agent': userAgent(),
  }
}

let cachedUserAgent = null
function userAgent() {
  if (cachedUserAgent === null) {
    cachedUserAgent = `QQBotAdapter/0.1.0 (Node/${process.versions.node}; ${process.platform}; dsh-qq)`
  }
  return cachedUserAgent
}

/** 解析代理：WSS_PROXY / HTTPS_PROXY / ALL_PROXY（WSL 下 QQ 网关直连常超时）。 */
export function resolveProxyUrl(env = process.env) {
  return (
    env.WSS_PROXY ||
    env.wss_proxy ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    ''
  ).trim?.() ?? ''
}

/** 动态加载代理依赖（可选依赖：未安装时如实报错，不影响直连路径）。 */
export async function loadProxyModules() {
  const [wsModule, agentModule] = await Promise.all([import('ws'), import('https-proxy-agent')])
  return {
    WebSocket: wsModule.default ?? wsModule.WebSocket,
    HttpsProxyAgent: agentModule.HttpsProxyAgent ?? agentModule.default,
  }
}

async function loadUndici() {
  return import('undici')
}

/** 等待 socket open（兼容浏览器式与 ws 式事件）。 */
function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = error => {
      cleanup()
      reject(new Error(`WebSocket 连接失败：${redact(error?.message ?? error)}`))
    }
    const cleanup = () => {
      detach(socket, 'open', onOpen)
      detach(socket, 'error', onError)
    }
    attach(socket, 'open', onOpen)
    attach(socket, 'error', onError)
  })
}

/**
 * socket 工厂：无代理用 Node ≥22 内置 WebSocket；有代理用 ws + https-proxy-agent
 * （ws 库不会因为环境变量存在就自动走代理——必须显式传 agent）。
 * @param {object} [spec]
 * @param {Function} [spec.proxyLoader] - 测试注入口。
 * @param {object} [spec.logger]
 */
export function createSocketFactory({ proxyLoader = loadProxyModules, logger = null } = {}) {
  return async function socketFactory(url, { proxyUrl } = {}) {
    const proxy = typeof proxyUrl === 'string' ? proxyUrl.trim() : ''
    if (proxy === '') {
      if (typeof globalThis.WebSocket !== 'function') {
        throw new Error('当前 Node 没有内置 WebSocket（需要 Node ≥ 22）')
      }
      const socket = new globalThis.WebSocket(url)
      await waitForOpen(socket)
      return socket
    }
    let modules
    try {
      modules = await proxyLoader()
    } catch (error) {
      throw new Error(
        `代理已配置（${redactProxy(proxy)}），但 ws / https-proxy-agent 不可用：${redact(error?.message ?? error)}；` +
          '请安装这两个可选依赖，或清除 *_PROXY 环境变量',
      )
    }
    const WsClient = modules?.WebSocket
    const Agent = modules?.HttpsProxyAgent
    if (typeof WsClient !== 'function' || typeof Agent !== 'function') {
      throw new Error('代理已配置，但 ws / https-proxy-agent 未提供可用的导出')
    }
    const socket = new WsClient(url, { agent: new Agent(proxy) })
    await waitForOpen(socket)
    try {
      logger?.info?.(`[qqbot] WebSocket 经代理连接：${redactProxy(proxy)}`)
    } catch {
      /* ignore */
    }
    return socket
  }
}

/**
 * fetch 工厂：配置代理时给请求挂 undici dispatcher（ProxyAgent / EnvHttpProxyAgent）；
 * undici 不可用时如实告警一次并直连（WebSocket 仍走代理）。
 * @param {object} [spec]
 */
export function createFetchImpl({ proxyUrl = '', proxyProvider = null, dispatcherLoader = loadUndici, logger = null } = {}) {
  const currentProxy = () => (typeof proxyProvider === 'function' ? String(proxyProvider() ?? '').trim() : String(proxyUrl ?? '').trim())
  if (currentProxy() === '' && typeof proxyProvider !== 'function') return globalThis.fetch
  let dispatcherPromise = null
  let warned = false
  return async (url, init = {}) => {
    const proxy = currentProxy()
    if (proxy === '') return globalThis.fetch(url, init)
    if (dispatcherPromise === null) {
      dispatcherPromise = (async () => {
        try {
          const undici = await dispatcherLoader()
          const EnvAgent = undici?.EnvHttpProxyAgent
          const ProxyAgent = undici?.ProxyAgent
          if (typeof EnvAgent === 'function') return new EnvAgent()
          if (typeof ProxyAgent === 'function') return new ProxyAgent(proxy)
          return null
        } catch {
          return null
        }
      })()
    }
    const dispatcher = await dispatcherPromise
    if (dispatcher === null || dispatcher === undefined) {
      if (!warned) {
        warned = true
        try {
          logger?.warn?.('[qqbot] 检测到代理，但 undici 不可用：HTTP 请求将直连（WebSocket 仍走代理）')
        } catch {
          /* ignore */
        }
      }
      return globalThis.fetch(url, init)
    }
    return globalThis.fetch(url, { ...init, dispatcher })
  }
}

/** 统一响应读取（JSON 或 null）。 */
async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

function chatKeyOf(target) {
  if (target.kind === 'dm') return `qqbot:${target.userId}`
  if (target.kind === 'group') return `qqbot:${target.groupId}`
  return `qqbot:${target.guildId}:${target.channelId}`
}

export default createTransport

// 共享工具再导出：chunkText/MAX_MESSAGE_LENGTH 定义在 transport.js（两个 transport 共用），
// 这里保留同名导出以维持 lib/qqbot.js 的既有 API（测试与调用方零改动）。
export { chunkText, MAX_MESSAGE_LENGTH }
