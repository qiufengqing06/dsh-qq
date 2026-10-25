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

/** 纯规则评分（无 IO，便于测试/调参）。 */
export function scoreMessage(ev) {
  const text = String(ev?.text ?? '').trim()
  const reasons = []
  let score = 0
  if (QUESTION_RE.test(text)) { score += 0.45; reasons.push('question') }
  if (text.length >= 8 && text.length <= 300) { score += 0.15; reasons.push('length') }
  if (Array.isArray(ev?.media) && ev.media.length > 0) { score += 0.05; reasons.push('media') }
  if (Array.isArray(ev?.atOthers) && ev.atOthers.length > 0) { score -= 0.25; reasons.push('at-others') }
  if (ev?.replyTo !== null && ev?.replyTo !== undefined) { score += 0.2; reasons.push('reply') }
  return { score: Math.max(0, Math.min(1, score)), reasons }
}

export function createParticipation({ config, store, logger = null, clock = () => Date.now() }) {
  const settings = config.participation ?? {}
  let lastWake = new Map()
  let wakeCounts = new Map()
  let day = todayKey(clock())

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

  /** 评估并决定是否唤醒；返回 {wake, score, reasons, skipped?}。 */
  function evaluate(ev) {
    if (settings.enabled !== true) return { wake: false, score: 0, reasons: [], skipped: 'disabled' }
    if (settings.mode === 'off') return { wake: false, score: 0, reasons: [], skipped: 'off' }
    if (ev?.target?.kind !== 'group') return { wake: false, score: 0, reasons: [], skipped: 'not-group' }
    if (ev?.mentioned === true) return { wake: false, score: 0, reasons: [], skipped: 'mentioned' }
    if (store.modeFor(ev.chatKey) !== 'chat') return { wake: false, score: 0, reasons: [], skipped: 'not-chat' }
    const now = clock()
    rollDay(now)
    if (inQuietHours(settings.quietHours, now)) return { wake: false, score: 0, reasons: [], skipped: 'quiet' }
    const last = lastWake.get(ev.chatKey) ?? 0
    if (now - last < (settings.cooldownMs ?? 120000)) return { wake: false, score: 0, reasons: [], skipped: 'cooldown' }
    const count = wakeCounts.get(ev.chatKey) ?? 0
    const limit = settings.dailyWakeLimit ?? 30
    if (limit > 0 && count >= limit) return { wake: false, score: 0, reasons: [], skipped: 'daily-limit' }
    const { score, reasons } = scoreMessage(ev)
    const threshold = settings.threshold ?? 0.55
    const pass = score >= threshold

    if (settings.mode === 'log') {
      log.info(`dsh-qq: 参与判断 log：score=${score.toFixed(2)} threshold=${threshold} pass=${pass} reasons=${reasons.join(',') || '-'}`)
      return { wake: false, score, reasons, skipped: 'log' }
    }
    if (!pass) return { wake: false, score, reasons, skipped: 'low-score' }
    lastWake.set(ev.chatKey, now)
    wakeCounts.set(ev.chatKey, count + 1)
    log.info(`dsh-qq: 参与判断唤醒：score=${score.toFixed(2)} reasons=${reasons.join(',') || '-'}`)
    return { wake: true, score, reasons }
  }

  return {
    enabled: settings.enabled === true,
    evaluate,
    shouldWake: ev => evaluate(ev).wake,
  }
}

export default createParticipation
