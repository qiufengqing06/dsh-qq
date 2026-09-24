/**
 * transport 契约与归一化（执行文档 §5.6，设计铁律 #1）。
 *
 * 一切协议差异（不同接入方式的差异）收敛到本文件的契约：
 *   - target 用结构化对象表达 dm/group/channel，不把 guild/channel 压平成 group；
 *   - chatKey 由 buildChatKey(transportKind, accountId, target) 统一生成（多协议、
 *     多账号命名空间隔离，杜绝 ID 碰撞）；
 *   - 入站事件由 makeInboundEvent() 归一化，上层（router/bridge/control/渠道注册表）
 *     只认这一种形状；
 *   - 能力差异一律通过 capabilities() 查询，上层禁止 `if (transport.kind === 'qqbot')`。
 *
 * 本模块零依赖、纯函数，可独立单测。
 */

/** 结构化 target 种类。 */
export const TARGET_KINDS = Object.freeze(['dm', 'group', 'channel'])

/** 渠道注册表（de_channel_send / de_notify）认识的 target 种类。 */
export const CHANNEL_TARGET_KINDS = Object.freeze(['p2p', 'group'])

/** transport 实现必须提供的槽位。 */
export const TRANSPORT_SLOTS = Object.freeze([
  'capabilities',
  'start',
  'stop',
  'status',
  'onMessage',
  'onInteraction',
  'sendText',
  'sendMedia',
  'sendKeyboard',
  'sendTyping',
])

/** 媒体种类。 */
export const MEDIA_KINDS = Object.freeze(['image', 'file', 'audio', 'video'])

/** 单条文本上限（QQ 官方 4000 字的安全值）。 */
export const MAX_MESSAGE_LENGTH = 4000

/**
 * 文本分段（各 transport 共用）：优先在换行处切，避免把一句话劈成两半。
 * @param {string} text
 * @param {number} [limit]
 * @returns {Array<string>} 空输入返回空数组
 */
export function chunkText(text, limit = MAX_MESSAGE_LENGTH) {
  const source = String(text ?? '')
  if (source.length <= limit) return source === '' ? [] : [source]
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

const TARGET_ID_FIELDS = Object.freeze({
  dm: ['userId'],
  group: ['groupId'],
  channel: ['guildId', 'channelId'],
})

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * 校验并规范化结构化 target。
 * @param {object} target - {kind:'dm',userId} | {kind:'group',groupId} | {kind:'channel',guildId,channelId}
 * @returns {{kind: string, [id: string]: string}} 冻结后的 target
 */
export function assertTarget(target) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('transport target must be an object')
  }
  const kind = target.kind
  if (!TARGET_KINDS.includes(kind)) {
    throw new TypeError(`transport target.kind must be one of ${TARGET_KINDS.join('|')}, got ${JSON.stringify(kind)}`)
  }
  const normalized = { kind }
  for (const field of TARGET_ID_FIELDS[kind]) {
    normalized[field] = nonEmptyString(target[field], `transport target.${field}`)
  }
  return Object.freeze(normalized)
}

/** target 的稳定字符串形式：dm:OPENID / group:GID / channel:GID:CID。 */
export function targetKey(target) {
  const t = assertTarget(target)
  if (t.kind === 'dm') return `dm:${t.userId}`
  if (t.kind === 'group') return `group:${t.groupId}`
  return `channel:${t.guildId}:${t.channelId}`
}

/**
 * 统一 chatKey 生成（铁律 #1）：`<transportKind>:<accountId>:<targetKey>`。
 * @param {string} transportKind - 传输种类（见 TRANSPORT_KINDS）
 * @param {string} accountId - 账号命名空间（如官方协议为 AppID）。
 * @param {object} target - 结构化 target。
 * @returns {string} chatKey
 */
export function buildChatKey(transportKind, accountId, target) {
  const kind = nonEmptyString(transportKind, 'buildChatKey: transportKind').toLowerCase()
  if (!/^[a-z0-9_-]+$/.test(kind)) {
    throw new TypeError(`buildChatKey: transportKind must match [a-z0-9_-]+, got ${JSON.stringify(kind)}`)
  }
  const account = nonEmptyString(String(accountId ?? ''), 'buildChatKey: accountId')
  if (account.includes(':')) {
    throw new TypeError(`buildChatKey: accountId must not contain ":", got ${JSON.stringify(account)}`)
  }
  return `${kind}:${account}:${targetKey(target)}`
}

/**
 * 解析 chatKey 回结构化 target（状态展示、迁移、渠道映射用）。
 * @param {string} chatKey
 * @returns {{transportKind: string, accountId: string, target: object}}
 */
export function parseChatKey(chatKey) {
  const raw = nonEmptyString(String(chatKey ?? ''), 'parseChatKey: chatKey')
  const parts = raw.split(':')
  if (parts.length < 4) throw new TypeError(`invalid chatKey: ${raw}`)
  const [transportKind, accountId, kind, ...ids] = parts
  if (!TARGET_KINDS.includes(kind)) throw new TypeError(`invalid chatKey target kind: ${raw}`)
  const need = TARGET_ID_FIELDS[kind].length
  if (ids.length !== need) throw new TypeError(`invalid chatKey id arity: ${raw}`)
  const target = { kind }
  TARGET_ID_FIELDS[kind].forEach((field, index) => {
    target[field] = ids[index]
  })
  return { transportKind, accountId, target: assertTarget(target) }
}

/**
 * 结构化 target → 渠道注册表 target（de_channel_send 契约：p2p | group）。
 * guild/channel 在渠道契约里以 `guildId:channelId` 复合 id 归入 group（唯一且可逆）。
 * @param {object} target - 结构化 target。
 * @returns {{kind: 'p2p'|'group', id: string}}
 */
export function toChannelTarget(target) {
  const t = assertTarget(target)
  if (t.kind === 'dm') return { kind: 'p2p', id: t.userId }
  if (t.kind === 'group') return { kind: 'group', id: t.groupId }
  return { kind: 'group', id: `${t.guildId}:${t.channelId}` }
}

/**
 * 渠道注册表 target → 结构化 target（recentChat 等出站路径使用）。
 * @param {{kind: string, id: string}} channelTarget
 * @param {string} [defaultTransportKind]
 * @param {string} [defaultAccountId]
 * @returns {{transportKind: string, accountId: string, target: object}|null}
 */
export function fromChannelTarget(channelTarget, defaultTransportKind = 'qqbot', defaultAccountId = '') {
  if (channelTarget === null || typeof channelTarget !== 'object') return null
  const { kind, id } = channelTarget
  if (typeof id !== 'string' || id === '') return null
  try {
    if (kind === 'p2p' || kind === 'dm') {
      return { transportKind: defaultTransportKind, accountId: defaultAccountId, target: assertTarget({ kind: 'dm', userId: id }) }
    }
    if (kind === 'group') {
      const sep = id.indexOf(':')
      // 复合 id（guildId:channelId）回解为 channel，其余按群处理
      if (sep > 0) {
        return {
          transportKind: defaultTransportKind,
          accountId: defaultAccountId,
          target: assertTarget({ kind: 'channel', guildId: id.slice(0, sep), channelId: id.slice(sep + 1) }),
        }
      }
      return { transportKind: defaultTransportKind, accountId: defaultAccountId, target: assertTarget({ kind: 'group', groupId: id }) }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 归一化 media 项。
 * @param {object} media
 * @returns {object} 冻结后的 media 项
 */
export function assertMedia(media) {
  if (media === null || typeof media !== 'object' || Array.isArray(media)) {
    throw new TypeError('transport media item must be an object')
  }
  if (!MEDIA_KINDS.includes(media.kind)) {
    throw new TypeError(`transport media.kind must be one of ${MEDIA_KINDS.join('|')}, got ${JSON.stringify(media.kind)}`)
  }
  const normalized = { kind: media.kind }
  for (const field of ['url', 'fileName', 'mime']) {
    if (media[field] !== undefined && media[field] !== null && media[field] !== '') {
      normalized[field] = String(media[field])
    }
  }
  if (media.size !== undefined) {
    const size = Number(media.size)
    if (!Number.isFinite(size) || size < 0) throw new TypeError('transport media.size must be a non-negative number')
    normalized.size = size
  }
  if (media.data !== undefined) normalized.data = media.data
  if (media.path !== undefined) normalized.path = String(media.path)
  // 语音转写：QQ 内置 ASR 结果随附件下发，必须原样保留给上层（否则会被静默丢弃）
  if (media.asrText !== undefined && media.asrText !== null && media.asrText !== '') {
    normalized.asrText = String(media.asrText)
  }
  return Object.freeze(normalized)
}

/**
 * 构造归一化入站事件（所有 transport 实现都必须经由本函数产出事件）。
 * @param {object} spec
 * @param {string} spec.transportKind
 * @param {string} spec.accountId
 * @param {object} spec.target - 结构化 target
 * @param {object} spec.sender - {id, name}
 * @param {string} spec.text
 * @param {string} [spec.messageId]
 * @param {number} [spec.timestamp]
 * @param {object|null} [spec.replyTo]
 * @param {Array<object>} [spec.media]
 * @param {boolean} [spec.mentioned]
 * @param {string} [spec.rawKind] - 协议原始消息类型（诊断用）
 * @returns {object} 冻结后的归一化事件
 */
export function makeInboundEvent(spec) {
  if (spec === null || typeof spec !== 'object') throw new TypeError('makeInboundEvent requires a spec object')
  const transportKind = nonEmptyString(spec.transportKind, 'inbound.transportKind').toLowerCase()
  const accountId = nonEmptyString(String(spec.accountId ?? ''), 'inbound.accountId')
  const target = assertTarget(spec.target)
  const chatKey = buildChatKey(transportKind, accountId, target)
  const sender = spec.sender ?? {}
  const text = typeof spec.text === 'string' ? spec.text : ''
  const media = Array.isArray(spec.media) ? spec.media.map(assertMedia) : []
  const timestamp = spec.timestamp === undefined ? Date.now() : Number(spec.timestamp)
  if (!Number.isFinite(timestamp)) throw new TypeError('inbound.timestamp must be a number')
  const messageId = spec.messageId === undefined || spec.messageId === null ? '' : String(spec.messageId)
  const replyTo =
    spec.replyTo && typeof spec.replyTo === 'object'
      ? Object.freeze({
          messageId: String(spec.replyTo.messageId ?? ''),
          text: typeof spec.replyTo.text === 'string' ? spec.replyTo.text : '',
        })
      : null
  return Object.freeze({
    eventId: messageId || `evt-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    messageId,
    timestamp,
    transportKind,
    accountId,
    chatKey,
    target,
    sender: Object.freeze({
      id: String(sender.id ?? ''),
      name: String(sender.name ?? ''),
    }),
    text,
    media: Object.freeze(media),
    replyTo,
    mentioned: spec.mentioned === true,
    rawKind: spec.rawKind === undefined ? '' : String(spec.rawKind),
  })
}

const DEFAULT_CAPABILITIES = Object.freeze({
  markdown: false,
  keyboard: false,
  typing: false,
  passiveReply: false,
  proactiveMessage: true,
  media: Object.freeze([]),
})

/**
 * 规范化 capabilities（未声明的能力一律视为不支持，fail-closed）。
 * @param {object} [spec]
 * @returns {object} 冻结后的能力表
 */
export function makeCapabilities(spec = {}) {
  const media = Array.isArray(spec.media) ? spec.media.filter(kind => MEDIA_KINDS.includes(kind)) : []
  return Object.freeze({
    markdown: spec.markdown === true,
    keyboard: spec.keyboard === true,
    typing: spec.typing === true,
    passiveReply: spec.passiveReply === true,
    proactiveMessage: spec.proactiveMessage !== false && DEFAULT_CAPABILITIES.proactiveMessage,
    media: Object.freeze(media),
  })
}

/** 该 transport 是否声明支持某种媒体。 */
export function supportsMedia(capabilities, kind) {
  return Array.isArray(capabilities?.media) && capabilities.media.includes(kind)
}

/**
 * markdown 开关解析：auto（按能力）/ on / off。
 * @param {'auto'|'on'|'off'} mode
 * @param {object} capabilities
 * @returns {boolean}
 */
export function wantsMarkdown(mode, capabilities) {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return capabilities?.markdown === true
}

/**
 * 契约自检：transport 实现缺槽位时抛出（第二实现兼容测试的基线）。
 * @param {object} impl
 * @returns {true} 契约完整时返回 true
 */
export function assertTransportContract(impl) {
  if (impl === null || typeof impl !== 'object') throw new TypeError('transport must be an object')
  if (typeof impl.kind !== 'string' || impl.kind.trim() === '') {
    throw new TypeError('transport.kind must be a non-empty string')
  }
  const missing = TRANSPORT_SLOTS.filter(slot => typeof impl[slot] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(`transport "${impl.kind}" is missing slots: ${missing.join(', ')}`)
  }
  const capabilities = impl.capabilities()
  if (capabilities === null || typeof capabilities !== 'object') {
    throw new TypeError(`transport "${impl.kind}".capabilities() must return an object`)
  }
  return true
}

/**
 * 契约说明对象（文档与测试共用；不是类，仅描述）。
 * 实现方（如 qqbot.js）返回的 API 必须覆盖 TRANSPORT_SLOTS。
 */
export const TransportContract = Object.freeze({
  kind: 'qqbot',
  capabilities: '() => { markdown, keyboard, typing, passiveReply, proactiveMessage, media[] }',
  start: 'async ({ signal }) => void',
  stop: 'async () => void',
  status: '() => { connected, phase, accountId, ... }',
  onMessage: '(handler) => disposer',
  onInteraction: '(handler) => disposer',
  sendText: 'async (target, text, opts) => { ok, messageId?, error? }',
  sendMedia: 'async (target, media, opts) => { ok, messageId?, error? }',
  sendKeyboard: 'async (target, text, buttons, opts) => { ok, messageId?, error? }',
  sendTyping: 'async (target, opts) => { ok }',
  downloadMedia: '(optional) async (url, {maxBytes, signal}) => { ok, data, contentType, bytes }',
  recentChat: "(optional) () => { kind: 'p2p'|'group', id } | null",
})

/**
 * 降级 transport：实现完整契约但一切发送如实报错、状态标记 unavailable。
 * 用于「transport 模块尚未实现（P1 的 qqbot.js）/ 加载失败」时，让插件仍能加载、
 * 命令与状态可用，而不是整体起不来。
 * @param {string} kind
 * @param {string} reason
 * @returns {object} transport
 */
export function createUnavailableTransport(kind, reason) {
  const capabilities = makeCapabilities({})
  const failure = () => ({ ok: false, error: `transport "${kind}" 不可用：${reason}` })
  return {
    kind: `${kind}-unavailable`,
    capabilities: () => capabilities,
    async start() {
      return false
    },
    async stop() {},
    status: () => ({ connected: false, phase: 'unavailable', kind, accountId: '', reason }),
    onMessage: () => () => {},
    onInteraction: () => () => {},
    sendText: async () => failure(),
    sendMedia: async () => failure(),
    sendKeyboard: async () => failure(),
    sendTyping: async () => failure(),
    recentChat: () => null,
  }
}
