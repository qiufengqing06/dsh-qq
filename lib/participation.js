/**
 * 参与判断（Phase 2）：群里没 @ 机器人时，决定这条消息值不值得唤醒模型。
 *
 * - 默认 enabled=false / mode=log；log 只记录分数，不改变行为；
 * - 不调用模型，只用确定性特征；
 * - 只有 chat 模式 + 群聊 + 非 @ 的消息会进来；命令/审批在 router 里先被拦掉；
 * - 官方线只收被 @ 的群消息，所以这项主要对个人线有效；
 * - 低分消息仍然进 groupMemory 缓冲，下一轮被 @ 时还能看到。
 */

import { inQuietHours, todayKey } from './scheduler.js'

const QUESTION_RE = /[?？]|怎么|为什么|为啥|如何|有没有|谁|哪个|哪里|求|帮|能不能|可以吗|怎么办|是不是/i
const END_RE = /^(?:嗯+|好(?:的|吧)?|行|ok|收到|谢谢|谢了|拜拜|再见|晚安|不用了|算了|先这样|到此为止|别回了|先别说了)[。.!！~～\s]*$/i
const CONTINUATION_MS = 60_000
const MAX_CONTINUOUS_WAKES = 3
const MAX_PARTICIPANTS = 4
const MAX_REPLY_IDS = 20
const MAX_CONVERSATIONS = 256

/** 只识别本实例的消息；不判断其他发送者是否为机器人。 */
function isOwnReply(ev, replyIds = null) {
  const author = String(ev?.replyTo?.sender?.id ?? '')
  const selfId = String(ev?.selfId || (ev?.transportKind === 'qqbot' ? '' : ev?.accountId) || '')
  const messageId = String(ev?.replyTo?.messageId ?? '')
  return (author !== '' && selfId !== '' && author === selfId)
    || (messageId !== '' && replyIds?.has(messageId) === true)
}

/** 纯规则评分（无 IO，便于测试/调参）。 */
export function scoreMessage(ev) {
  const text = String(ev?.text ?? '').trim()
  const reasons = []
  let score = 0
  if (QUESTION_RE.test(text)) { score += 0.45; reasons.push('question') }
  if (text.length >= 8 && text.length <= 300) { score += 0.15; reasons.push('length') }
  if (Array.isArray(ev?.media) && ev.media.length > 0) { score += 0.05; reasons.push('media') }
  if (Array.isArray(ev?.atOthers) && ev.atOthers.length > 0) { score -= 0.25; reasons.push('at-others') }
  if (isOwnReply(ev)) { score += 0.2; reasons.push('reply-self') }
  else if (ev?.replyTo?.sender?.id) { score -= 0.25; reasons.push('reply-other') }
  return { score: Math.max(0, Math.min(1, score)), reasons }
}

export function createParticipation({ config, store, logger = null, clock = () => Date.now() }) {
  const settings = { mode: 'log', ...config.participation }
  let lastWake = new Map()
  let wakeCounts = new Map()
  let day = todayKey(clock())
  const conversations = new Map()
  /** 最近判定（只记分数/原因，不记正文；页面观察面板用）。 */
  const recent = []
  const record = (decision, ev) => {
    recent.push({
      at: clock(),
      chatKey: String(ev?.chatKey ?? ''),
      score: Number(decision?.score) || 0,
      wake: decision?.wake === true,
      skipped: String(decision?.skipped ?? ''),
      reasons: Array.isArray(decision?.reasons) ? decision.reasons.slice(0, 6) : [],
    })
    if (recent.length > 80) recent.splice(0, recent.length - 80)
  }

  const log = {
    info: message => { try { logger?.info?.(message) } catch { /* ignore */ } },
    debug: message => { try { logger?.debug?.(message) } catch { /* ignore */ } },
  }

  function rollDay(now) {
    const today = todayKey(now)
    if (today !== day) {
      day = today
      wakeCounts = new Map()
    }
  }

  function conversationOf(chatKey, now, create = false) {
    for (const [key, value] of conversations) {
      if (value.expiresAt <= now) conversations.delete(key)
    }
    let conversation = conversations.get(chatKey)
    if (conversation === undefined && create) {
      conversation = { expiresAt: now + CONTINUATION_MS, participants: new Map(), replyIds: new Set(), automatic: 0 }
      conversations.set(chatKey, conversation)
      if (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value)
    }
    return conversation
  }

  /**
   * 成功出站后调用：senderId 是本轮回答的群友，messageId 是本实例实际发出的消息。
   * explicit 仅在明确 @ 发起的回答首条成功出站时为 true；其他群友始终同等处理。
   * 不在这里计主动次数（按准入回合计），多气泡不会多占名额。
   */
  function observeReply({ chatKey, senderId, messageId = '', explicit = false, at = clock() } = {}) {
    if (typeof chatKey !== 'string' || chatKey === '' || store.modeFor(chatKey) !== 'chat') return
    const now = Number.isFinite(at) ? at : clock()
    const conversation = conversationOf(chatKey, now, true)
    const id = String(messageId ?? '')
    if (id !== '' && conversation.replyIds.has(id)) return
    if (explicit) conversation.automatic = 0
    conversation.expiresAt = now + CONTINUATION_MS
    const participant = String(senderId ?? '')
    if (participant !== '') {
      conversation.participants.delete(participant)
      conversation.participants.set(participant, now + CONTINUATION_MS)
      if (conversation.participants.size > MAX_PARTICIPANTS) conversation.participants.delete(conversation.participants.keys().next().value)
    }
    if (id !== '') {
      conversation.replyIds.add(id)
      if (conversation.replyIds.size > MAX_REPLY_IDS) conversation.replyIds.delete(conversation.replyIds.values().next().value)
    }
  }

  /** 评估并决定是否唤醒；返回 {wake, score, reasons, skipped?}。 */
  function evaluate(ev) {
    const done = decision => { record(decision, ev); return decision }
    if (settings.enabled !== true) return { wake: false, score: 0, reasons: [], skipped: 'disabled' }
    if (settings.mode === 'off') return { wake: false, score: 0, reasons: [], skipped: 'off' }
    if (ev?.target?.kind !== 'group') return { wake: false, score: 0, reasons: [], skipped: 'not-group' }
    if (ev?.mentioned === true) return { wake: false, score: 0, reasons: [], skipped: 'mentioned' }
    if (store.modeFor(ev.chatKey) !== 'chat') return { wake: false, score: 0, reasons: [], skipped: 'not-chat' }
    const now = clock()
    rollDay(now)
    if (typeof store.chatPreference === 'function' && store.chatPreference(ev.chatKey).proactiveUntil > now) {
      return { wake: false, score: 0, reasons: [], skipped: 'chat-paused' }
    }
    if (typeof store.memberPreference === 'function' && store.memberPreference(ev.chatKey, ev.sender?.id).proactiveUntil > now) {
      return { wake: false, score: 0, reasons: [], skipped: 'member-paused' }
    }
    if (inQuietHours(settings.quietHours, now)) return { wake: false, score: 0, reasons: [], skipped: 'quiet' }
    const conversation = conversationOf(ev.chatKey, now)
    const ownReply = isOwnReply(ev, conversation?.replyIds)
    const participant = String(ev.sender?.id ?? '')
    const continuing = ownReply || (conversation?.participants.get(participant) ?? 0) > now
    if (Array.isArray(ev.atOthers) && ev.atOthers.length > 0) {
      return done({ wake: false, score: 0, reasons: ['at-others'], skipped: 'addressed-other' })
    }
    if (ev.replyTo?.sender?.id && !ownReply) {
      return done({ wake: false, score: 0, reasons: ['reply-other'], skipped: 'addressed-other' })
    }
    if (END_RE.test(String(ev.text ?? '').trim())) {
      // log 只是观察，不能让原有免 @ 对话因评分改变状态。
      if (settings.mode === 'block' && continuing) conversation?.participants.delete(participant)
      return done({ wake: false, score: 0, reasons: ['ending'], skipped: 'conversation-ended' })
    }
    if ((conversation?.automatic ?? 0) >= MAX_CONTINUOUS_WAKES) {
      return done({ wake: false, score: 0, reasons: [], skipped: 'continuation-limit' })
    }
    const last = lastWake.get(ev.chatKey)
    if (!continuing && last !== undefined && now - last < (settings.cooldownMs ?? 120000)) {
      return done({ wake: false, score: 0, reasons: [], skipped: 'cooldown' })
    }
    const count = wakeCounts.get(ev.chatKey) ?? 0
    const limit = settings.dailyWakeLimit ?? 30
    if (limit > 0 && count >= limit) return { wake: false, score: 0, reasons: [], skipped: 'daily-limit' }
    const scored = scoreMessage(ev)
    const score = continuing ? 1 : scored.score
    const reasons = continuing ? [ownReply ? 'reply-self' : 'continuation'] : scored.reasons
    const threshold = settings.threshold ?? 0.55
    const pass = score >= threshold

    if (settings.mode === 'log') {
      const decision = { wake: false, score, reasons, skipped: 'log' }
      record(decision, ev)
      log.info(`dsh-qq: 参与判断 log：score=${score.toFixed(2)} threshold=${threshold} pass=${pass} reasons=${reasons.join(',') || '-'}`)
      return decision
    }
    if (!pass) {
      const decision = { wake: false, score, reasons, skipped: 'low-score' }
      record(decision, ev)
      return decision
    }
    lastWake.set(ev.chatKey, now)
    wakeCounts.set(ev.chatKey, count + 1)
    conversationOf(ev.chatKey, now, true).automatic += 1
    log.info(`dsh-qq: 参与判断唤醒：score=${score.toFixed(2)} reasons=${reasons.join(',') || '-'}`)
    const decision = { wake: true, score, reasons }
    record(decision, ev)
    return decision
  }

  return {
    enabled: settings.enabled === true,
    evaluate,
    shouldWake: ev => evaluate(ev).wake,
    observeReply,
    onReply: observeReply,
    snapshot: () => ({
      enabled: settings.enabled === true,
      mode: settings.mode,
      threshold: settings.threshold,
      quietHours: settings.quietHours,
      recent: recent.map(item => ({ ...item, reasons: [...item.reasons] })),
    }),
  }
}

export default createParticipation
