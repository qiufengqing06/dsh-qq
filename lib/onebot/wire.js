/**
 * OneBot 11 协议线层（纯函数，零 IO、零依赖）——二期 transport（NapCat / Lagrange / LLOneBot）专用。
 *
 * 设计铁律 #1：一切协议差异收敛在 transport 层。本文件只做「协议 ↔ 归一化」的双向翻译，
 * 不碰 socket、不碰 store、不读配置；这样协议部分可以完全离线单测，transport 只负责连接与调度。
 *
 * 覆盖范围（OneBot 11 标准 + NapCat 实测形状）：
 *   - 消息段 ↔ 文本/媒体（含 CQ 码字符串兜底：`messagePostFormat: string` 时也能解析）
 *   - 事件归一化 → makeInboundEvent 形状（dm / group，群聊 @ 判定、群名片优先）
 *   - retcode 分类（成功 / 不可重试 / 可重试）
 *   - 引用段（reply）的失效判定与剥离（NapCat 消息 ID 是 LRU 哈希，会过期）
 */

import { makeInboundEvent } from '../transport.js'

/** 媒体段类型 → 归一化 media.kind。 */
export const SEGMENT_MEDIA_KIND = Object.freeze({
  image: 'image',
  record: 'audio',
  video: 'video',
  file: 'file',
})

/** 入站会转成媒体的段类型。 */
export const MEDIA_SEGMENT_TYPES = Object.freeze(Object.keys(SEGMENT_MEDIA_KIND))

/** 段里可能承载文件地址的字段（不同实现给的不同）。 */
const FILE_FIELDS = Object.freeze(['url', 'file', 'path', 'file_id', 'file_unique'])

/**
 * 解析 CQ 码字符串（`[CQ:at,qq=123]` 这类）。仅作为 `messagePostFormat: string` 的兜底，
 * 标准路径是 array 段数组；无法识别的码原样保留为文本。
 * @param {string} raw
 * @returns {Array<{type: string, data: object}>} 段数组
 */
export function parseCqCodes(raw) {
  const text = String(raw ?? '')
  if (text === '') return []
  const segments = []
  const pattern = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g
  let cursor = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ type: 'text', data: { text: unescapeCq(text.slice(cursor, match.index)) } })
    const data = {}
    for (const pair of String(match[2] ?? '').replace(/^,/, '').split(',')) {
      if (pair === '') continue
      const index = pair.indexOf('=')
      if (index < 0) continue
      const key = pair.slice(0, index).trim()
      if (key === '') continue
      data[key] = unescapeCq(pair.slice(index + 1))
    }
    segments.push({ type: match[1], data })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: unescapeCq(text.slice(cursor)) } })
  return segments
}

/** CQ 码实体反转义（&#91; &#93; &#44; &amp;）。 */
function unescapeCq(value) {
  return String(value)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
}

/**
 * CQ 码实体转义（发 string 格式时用）。
 * @param {string} value
 * @returns {string}
 */
export function escapeCq(value) {
  return String(value).replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
}

/**
 * 归一化「消息」字段：array 段数组 / string（CQ 码）→ 段数组。
 * @param {unknown} message
 * @returns {Array<{type: string, data: object}>}
 */
export function toSegments(message) {
  if (Array.isArray(message)) {
    return message
      .filter(segment => segment !== null && typeof segment === 'object')
      .map(segment => ({
        type: String(segment.type ?? ''),
        data: segment.data !== null && typeof segment.data === 'object' ? segment.data : {},
      }))
      .filter(segment => segment.type !== '')
  }
  if (typeof message === 'string') return parseCqCodes(message)
  if (message !== null && typeof message === 'object') {
    // 少数实现把单段直接当对象给
    return toSegments([message])
  }
  return []
}

/**
 * 从段数组里取第一个可用的地址（url 优先，其次 file/path/file_id）。
 * @param {object} data - 段 data
 * @returns {string}
 */
function fileRefOf(data) {
  for (const field of FILE_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * 段数组 → 文本 + 媒体 + @判定 + 引用。
 *
 * @param {Array<{type: string, data: object}>} segments
 * @param {object} [options]
 * @param {string} [options.selfId] - 机器人自身 QQ 号（用于 @ 判定）
 * @returns {{text: string, media: Array<object>, mentioned: boolean, replyTo: object|null, atOthers: Array<string>, mentionedIds: Array<string>}}
 */
export function parseSegments(segments, { selfId = '' } = {}) {
  const list = Array.isArray(segments) ? segments : []
  const parts = []
  const media = []
  const atOthers = []
  const mentionedIds = []
  let mentioned = false
  let replyTo = null

  for (const segment of list) {
    const data = segment?.data ?? {}
    switch (segment?.type) {
      case 'text': {
        const text = typeof data.text === 'string' ? data.text : ''
        if (text !== '') parts.push(text)
        break
      }
      case 'at': {
        const qq = String(data.qq ?? '')
        if (qq === '') break
        if (!mentionedIds.includes(qq)) mentionedIds.push(qq)
        if (qq === 'all') {
          // @全体成员：既不等于 @自己、也不是普通文本，但群里发公告时很重要。
          // 置 mentioned（机器人应当看见这条）+ 文本占位（模型能理解语境）。
          mentioned = true
          parts.push('[@全体成员]')
          break
        }
        if (selfId !== '' && qq === selfId) {
          // 自己被 @：只置 mentioned，**不往文本里加标记**——
          // router 的 parseCommand 要求文本以 / 开头，任何前缀都会让
          // 「@机器人 /qq-status」被当成普通对话丢给模型（真机踩过）。
          mentioned = true
        } else {
          atOthers.push(qq)
          parts.push(`@${qq}`)
        }
        break
      }
      case 'reply': {
        const messageId = String(data.id ?? data.message_id ?? '')
        if (messageId !== '') replyTo = { messageId }
        break
      }
      case 'face':
      case 'mface':
      case 'rps':
      case 'dice': {
        // 表情类：保留一个可读占位，别让模型以为消息是空的
        parts.push('[表情]')
        break
      }
      case 'forward':
      case 'node': {
        // 合并转发：内容需要 get_forward_msg 才能展开（按需拉取，不做全量归档）。
        // 把 id 留在文本里，模型被问到时至少知道去查哪一条。
        const forwardId = String(data.id ?? data.forward_id ?? data.res_id ?? '')
        parts.push(forwardId === '' ? '[合并转发消息]' : `[合并转发消息 id=${forwardId}]`)
        break
      }
      default: {
        const kind = SEGMENT_MEDIA_KIND[segment?.type]
        if (kind === undefined) break
        const ref = fileRefOf(data)
        if (ref === '') break
        // 文件名/大小在不同实现里叫法不同（NapCat 的群文件段用 file_name/file_size），
        // 都要认：引用文件消息时模型看到的标签就靠它们（「文件 2025级硕士0915.xls (285.0KB)」）。
        const name = [data.name, data.file_name, data.filename].find(value => typeof value === 'string' && value !== '')
        const size = Number(data.file_size ?? data.size)
        media.push({
          kind,
          url: ref,
          ...(name === undefined ? {} : { fileName: name }),
          ...(Number.isFinite(size) && size > 0 ? { size } : {}),
          ...(kind === 'audio' && typeof data.asr_refer_text === 'string' && data.asr_refer_text !== ''
            ? { asrText: data.asr_refer_text }
            : {}),
        })
        break
      }
    }
  }

  const text = parts.join('').trim()
  return { text, media, mentioned, replyTo, atOthers, mentionedIds }
}

/**
 * 归一化 OneBot 11 事件 → dsh-qq 归一化入站事件。
 *
 * 只处理 `post_type=message`（私聊 / 群聊）；notice / request / meta_event 由 transport 自行分流
 * （它们不进 DSH 会话，见 lib/onebot/transport.js）。
 *
 * @param {object} raw - OneBot 事件对象
 * @param {object} spec
 * @param {string} spec.accountId - 已登录的 self_id（chatKey 命名空间）
 * @param {string} [spec.selfId] - 同 accountId（保留显式入口便于测试）
 * @param {(id: string) => object|null} [spec.lookupReply] - 引用消息的查找器（可选，用于填 replyTo.text）
 * @returns {object|null} makeInboundEvent 结果；非消息事件或不认识的形状返回 null
 */
export function normalizeOneBotEvent(raw, { accountId, selfId = '', lookupReply = null } = {}) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.post_type !== 'message') return null
  const account = String(accountId ?? '').trim()
  if (account === '') throw new TypeError('normalizeOneBotEvent requires accountId')
  const bot = selfId === '' ? account : String(selfId)
  const messageType = String(raw.message_type ?? '')

  let target
  let sender
  let defaultMentioned
  if (messageType === 'private') {
    const userId = String(raw.user_id ?? '')
    if (userId === '') return null
    target = { kind: 'dm', userId }
    sender = { id: userId, name: String(raw.sender?.nickname ?? '') }
    defaultMentioned = true
  } else if (messageType === 'group') {
    const groupId = String(raw.group_id ?? '')
    const userId = String(raw.user_id ?? '')
    if (groupId === '' || userId === '') return null
    target = { kind: 'group', groupId }
    // 群里优先群名片：模型需要知道「谁在说话」，昵称比 QQ 号可读
    const card = String(raw.sender?.card ?? '')
    const nickname = String(raw.sender?.nickname ?? '')
    sender = { id: userId, name: card !== '' ? card : nickname }
    defaultMentioned = false
  } else {
    // guild / channel 不在 OneBot 11 范围内
    return null
  }

  const parsed = parseSegments(toSegments(raw.message), { selfId: bot })
  // 注意：**不要**在这里给文本加「[群名片] 」前缀。协议事件必须保持原样，
  // 前缀属于展示层（bridge.buildContent 负责），否则群里发命令时
  // 「[秋风清] @我 /qq-status」不以 / 开头，命令会被当成对话送进模型（真机踩过）。
  const text = parsed.text
  const replySegment = parsed.replyTo
  let replyTo = null
  if (replySegment !== null) {
    const looked = typeof lookupReply === 'function' ? lookupReply(replySegment.messageId) : null
    const quotedMedia = Array.isArray(looked?.media) ? looked.media : []
    const quotedSender = looked?.sender ?? null
    replyTo = {
      messageId: replySegment.messageId,
      text: typeof looked?.text === 'string' ? looked.text : '',
      // 谁说的同样要带上：引用别人的消息时，模型必须知道这句话出自谁（真机 2026-09-24：
      // 引用群友消息提问，模型答不出「谁发的」——只有原文、没有发送人）。
      ...(quotedSender === null || typeof quotedSender !== 'object'
        ? {}
        : { sender: { id: String(quotedSender.id ?? ''), name: String(quotedSender.name ?? '') } }),
      // 被引用的消息可能**只有媒体没有文本**（QQ 里文件和文字没法合并在一条消息里，
      // 群文件的标准用法就是「先发文件，再引用它提问」）。把它的附件一起带上，
      // 否则引用会退化成空引用，模型只能回「我这边没收到附件」（真机 2026-09-24）。
      ...(quotedMedia.length === 0 ? {} : { media: quotedMedia }),
    }
  }

  return makeInboundEvent({
    transportKind: 'onebot',
    accountId: account,
    selfId: bot,
    target,
    sender,
    text,
    messageId: raw.message_id === undefined || raw.message_id === null ? '' : String(raw.message_id),
    timestamp: Number(raw.time ?? 0) > 0 ? Number(raw.time) * 1000 : Date.now(),
    media: parsed.media,
    mentionedIds: parsed.mentionedIds,
    atOthers: parsed.atOthers,
    replyTo,
    mentioned: messageType === 'private' ? defaultMentioned : parsed.mentioned,
    rawKind: `${messageType}${raw.sub_type === undefined ? '' : `/${String(raw.sub_type)}`}`,
  })
}

/**
 * OneBot 响应分类：`{status, retcode, data, echo}` → 统一结果（含重试语义）。
 *
 * 三态 outcome（不要把 retcode=1 当普通成功）：
 *   success         retcode=0，确实做完了
 *   accepted-async  retcode=1，对方已受理但最终结果未知，**且不保证有 message_id**
 *   failure         其它
 *
 * 三态 retryClass（比 boolean 更安全）：
 *   safe             重试是幂等的（读操作、连接前的失败）
 *   unknown-outcome  请求可能已经生效（写操作的超时/连接中断）：**默认绝不自动重试**，
 *                    否则会重复发消息、重复上传、重复处理请求
 *   never            参数/权限类错误，重试没有意义
 *
 * @param {object} response - 已解析的响应体（可为 null，表示超时或未发出）
 * @param {object} [options]
 * @param {string} [options.action] - 动作名（诊断）
 * @param {boolean} [options.mutating] - 是否是写操作（写操作的不确定结果不能自动重试）
 * @returns {{ok, outcome, retryClass, retryable, data, retcode, operation, error}}
 */
export function classifyResponse(response, { action = '', mutating = false } = {}) {
  const label = action === '' ? 'OneBot 调用' : `OneBot ${action}`
  if (response === null || typeof response !== 'object') {
    // 没有响应：读操作可以安全重试；写操作的结果**未知**（可能已生效），不能重试
    return {
      ok: false,
      outcome: 'failure',
      retryClass: mutating ? 'unknown-outcome' : 'safe',
      retryable: mutating !== true,
      data: null,
      retcode: -1,
      operation: action,
      error: `${label}失败：无响应（超时或连接中断）${mutating ? '，写操作结果未知' : ''}`,
    }
  }
  const retcode = Number(response.retcode ?? 0)
  const status = String(response.status ?? '')
  const data = response.data !== null && typeof response.data === 'object' ? response.data : null
  if (retcode === 0) {
    return { ok: true, outcome: 'success', retryClass: 'never', retryable: false, data, retcode, operation: action, error: '' }
  }
  if (retcode === 1) {
    // 异步受理：算「已接受」，但不是「成功」；调用方不要假设一定有 message_id
    return { ok: true, outcome: 'accepted-async', retryClass: 'never', retryable: false, data, retcode, operation: action, error: '' }
  }
  const message = String(response.message ?? response.wording ?? status ?? '未知错误')
  const retryClass = retryableRetcode(retcode) ? 'safe' : 'never'
  return {
    ok: false,
    outcome: 'failure',
    retryClass,
    retryable: retryClass === 'safe',
    data: null,
    retcode,
    operation: action,
    error: `${label}失败（retcode=${retcode}）：${message}`,
  }
}

/**
 * retcode 是否值得重试。
 * @param {number} retcode
 * @returns {boolean}
 */
export function retryableRetcode(retcode) {
  const code = Number(retcode)
  if (!Number.isFinite(code)) return true
  if (code === 0 || code === 1) return false
  // 1xx = 参数错/不支持/无权限：重试没有意义
  if (code >= 100 && code < 200) return false
  // 14xx = 实现层沿用 HTTP 语义的错误（1400 参数、1401 未鉴权、1403 禁止/token 校验失败、1404 不存在）
  if (code >= 1400 && code < 1500) return false
  // 2xx 处理失败、3xx 服务未就绪、其余实现层异常：值得退避重试
  return true
}

/** NapCat 的 WS token 校验失败码（真机实测：握手不拦，请求层返回 retcode=1403「token验证失败」）。 */
export const AUTH_FAILURE_CODES = new Set([1401, 1403])

/**
 * 判断失败是否属于「鉴权失败」：这类错误重试无意义，必须停下来让用户核对 token。
 * @param {{retcode?: number, error?: string}} failure
 * @returns {boolean}
 */
export function isAuthFailure(failure) {
  const code = Number(failure?.retcode ?? 0)
  if (AUTH_FAILURE_CODES.has(code)) return true
  return /token验证失败|token\s*(验证|校验)?失败|unauthorized|invalid\s*token/i.test(String(failure?.error ?? ''))
}

/** 引用失效类 retcode / 文案（NapCat 的 message_id 是 LRU 哈希，过期后引用会失败）。 */
const REFERENCE_HINTS = /reply|message_id|msg_id|消息.*(不存在|过期|失效)|not\s*found/i

/**
 * 判断失败是否由「引用段」引起（用于去掉 reply 段重发一次）。
 * @param {{retcode?: number, error?: string}} failure
 * @returns {boolean}
 */
export function isReferenceFailure(failure) {
  const error = String(failure?.error ?? '')
  if (REFERENCE_HINTS.test(error)) return true
  // 参数类 retcode + 提到消息，基本就是引用无效
  const code = Number(failure?.retcode ?? 0)
  return (code === 100 || code === 102) && /消息|message/i.test(error)
}

/**
 * 去掉消息数组里的 reply 段（保留其余段顺序）。
 * @param {Array<object>} segments
 * @returns {Array<object>}
 */
export function stripReplySegment(segments) {
  return (Array.isArray(segments) ? segments : []).filter(segment => segment?.type !== 'reply')
}

/**
 * 构造文本消息段数组。
 * @param {string} text
 * @returns {Array<{type: 'text', data: {text: string}}>}
 */
export function textSegments(text) {
  const content = String(text ?? '')
  if (content === '') return []
  return [{ type: 'text', data: { text: content } }]
}

/**
 * 构造引用段。
 * @param {string} messageId
 * @returns {Array<{type: 'reply', data: {id: string}}>}
 */
export function replySegment(messageId) {
  const id = String(messageId ?? '')
  if (id === '') return []
  return [{ type: 'reply', data: { id } }]
}

/**
 * 说话人显示名：群名片优先，其次昵称，最后回落到 QQ 号。
 * @param {{id?: string, name?: string}} sender
 * @returns {string}
 */
export function speakerName(sender) {
  const name = String(sender?.name ?? '').trim()
  if (name !== '') return name
  const id = String(sender?.id ?? '').trim()
  return id === '' ? '' : id
}

export default {
  classifyResponse,
  isReferenceFailure,
  normalizeOneBotEvent,
  parseCqCodes,
  parseSegments,
  replySegment,
  retryableRetcode,
  speakerName,
  stripReplySegment,
  textSegments,
  toSegments,
}
