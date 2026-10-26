/** Shared, deterministic chat preferences. Profiles never enable a disabled feature. */
export const CHAT_ACTIVITY_MODES = Object.freeze(['inherit', 'quiet', 'normal', 'active'])

export function normalizeActivity(raw, { strict = false } = {}) {
  if (CHAT_ACTIVITY_MODES.includes(raw)) return raw
  if (strict) throw new Error('活跃档位必须是 inherit、quiet、normal 或 active')
  return 'inherit'
}

export function normalizeAliases(raw, { strict = false } = {}) {
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('昵称必须是字符串数组')
    return []
  }
  const aliases = []
  for (const value of raw) {
    const alias = typeof value === 'string' ? value.trim() : ''
    const valid = typeof value === 'string' && !/[\p{Cc}\p{Cf}]/u.test(value) && [...alias].length >= 2 && [...alias].length <= 20
    if (!valid) {
      if (strict) throw new Error('每个昵称须为 2–20 字，且不能包含控制字符')
      continue
    }
    if (!aliases.includes(alias)) aliases.push(alias)
  }
  if (strict && aliases.length > 8) throw new Error('每个人设最多设置 8 个昵称')
  return aliases.slice(0, 8)
}

/** Anchored vocatives only: mentioning someone's name in a statement is not a summons. */
export function isAliasAddressed(text, aliases) {
  const body = String(text ?? '').trim()
  const punctuation = '[\\s，,。.!！?？：:、~～]*'
  const call = '(?:在吗|在不在|出来|出列|说话|回话|回我|理我|过来|聊聊)'
  for (const alias of normalizeAliases(aliases)) {
    const name = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`^${name}${punctuation}$`, 'iu').test(body)) return true
    if (new RegExp(`^${name}${punctuation}(?:你|您|帮我|请问|请你|能不能|可不可以|给我|回答我|解释一下)`, 'iu').test(body)) return true
    if (new RegExp(`^${name}${punctuation}${call}(?:一下|呀|啊|嘛|吧|呗|啦)?${punctuation}$`, 'iu').test(body)) return true
    if (new RegExp(`^${call}(?:[\\s，,、！!？?]+${call})*[\\s，,：:]+${name}${punctuation}$`, 'iu').test(body)) return true
  }
  return false
}

export function activityNote(activity) {
  if (activity === 'quiet') return '本群偏好安静：被叫到或正在接话时自然回应；少主动加入新话题，表情只在特别贴切时使用。'
  if (activity === 'active') return '本群偏好活跃：有相关话题或合适的梗时可以更积极接话，并用贴切表情表达；仍尊重暂停和发言对象，不为活跃而硬接每句话。'
  return ''
}

export function participationSettings(settings = {}, activity = 'inherit') {
  if (activity !== 'quiet' && activity !== 'active') return { ...settings }
  const quiet = activity === 'quiet'
  return { ...settings,
    threshold: Math.max(0, Math.min(1, Number(((settings.threshold ?? 0.55) + (quiet ? 0.05 : -0.1)).toFixed(3)))),
    cooldownMs: Math.round((settings.cooldownMs ?? 120000) * (quiet ? 2 : 0.5)),
  }
}

export function stickerSendSettings(settings = {}, activity = 'inherit') {
  if (activity !== 'quiet' && activity !== 'active') return { ...settings }
  return { ...settings, cooldownMs: Math.round((settings.cooldownMs ?? 30000) * (activity === 'quiet' ? 2 : 0.5)) }
}
