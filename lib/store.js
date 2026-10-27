/**
 * 原子 JSON store（执行文档 §5.7，评审 §11 采纳）。
 *
 * 状态规模很小（chatKey→session 指针、最近会话、白名单、home channel），
 * 因此用单文件原子 JSON（tmp + fsync + rename），不用 JSONL：
 * JSONL 的重复记录、replay、compact、半行修复、schema 迁移在这个规模纯属负担。
 *
 * 崩溃安全：写 tmp → fsync → rename（同目录 rename 原子）；读到损坏 JSON 时
 * 备份为 `<file>.corrupt-<ts>` 并重建空状态，绝不让插件因状态文件损坏起不来。
 */

import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeActivity as normalizeChatActivity, normalizeAliases } from './chat-behavior.js'

export const STORE_VERSION = 1
/** 每个 chat 保留的最近会话数。 */
export const MAX_RECENT_SESSIONS = 10

function emptyState() {
  return {
    version: STORE_VERSION,
    chats: {},
    pairing: { policy: 'pairing', roles: {}, pending: [] },
    meta: { homeChannel: '', homeChannels: {}, accountId: '', updatedAt: 0 },
    // 按天、按线路的消息计数（控制台「近 7 天活动量」用）：{ 'YYYY-MM-DD': { qqbot: n, onebot: n } }
    activity: {},
    // 按天、按对话的 token 用量（控制台「Token 消耗」用）：
    // { 'YYYY-MM-DD': { '<chatKey>': { in, out, total, turns } } }
    usage: {},
    // 最近审批记录（控制台「最近审批」用；最多 50 条，只留决策元数据）：
    // [{ at, chatKey, decision, actorId, summary, approvalId }]
    approvals: [],
    // 会话级 system prompt：default 对所有 QQ 对话生效，chats 按 chatKey 覆盖：
    // { default: string, chats: { '<chatKey>': string } }
    prompt: { default: '', chats: {} },
    // 命名人设库与绑定：personas[id] = { name, text, updatedAt }
    personas: {},
    defaultPersonaId: '',
    // chatKey → { personaId, updatedAt }；旧字段（迁移后清空）
    personaBindings: {},
    // chatKey → { work: {personaId,updatedAt}|undefined, chat: ... }；按模式绑定人设
    personaModeBindings: {},
    // 最近使用/收藏的人设 id（控制台快捷选择用；全局，最多 8/50）
    personaRecent: [],
    personaFavorites: [],
    // 人设/提示词变更版本：bridge 用它取消旧人设下尚未发出的气泡
    personaRevision: 0,
    // 定时提醒/主动任务（按 chat 持久化；见 lib/scheduler.js）
    schedules: [],
    // 明确偏好/静默：chats[chatKey] = { proactiveUntil, stickers }；members[chatKey][userId] = { name, proactiveUntil }
    preferences: { chats: {}, members: {} },
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 保留多少天的活动计数（超出自动裁掉，避免状态文件无界增长）。 */
export const ACTIVITY_KEEP_DAYS = 30

/** 本地日期键 YYYY-MM-DD（按本机时区，用户看的是本地日历）。 */
export function activityDateKey(at) {
  const date = new Date(at)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 把磁盘上的活动计数归一化：只要数字、保留最近 ACTIVITY_KEEP_DAYS 天。 */
function normalizeActivity(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const cutoff = Date.now() - ACTIVITY_KEEP_DAYS * 86400_000
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || value === null || typeof value !== 'object') continue
    const parsed = Date.parse(`${key}T00:00:00`)
    if (Number.isFinite(parsed) && parsed < cutoff) continue
    const counts = {}
    for (const [kind, count] of Object.entries(value)) {
      const n = Number(count)
      if (typeof kind === 'string' && kind !== '' && Number.isFinite(n) && n > 0) counts[kind] = Math.floor(n)
    }
    out[key] = counts
  }
  return out
}

/** 近 N 天（含今天）的活动序列，缺失的天补 0，让控制台能画完整柱状图。 */
function activitySeries(state, days, at) {
  const out = []
  for (let index = days - 1; index >= 0; index -= 1) {
    const dayAt = at - index * 86400_000
    const key = activityDateKey(dayAt)
    const counts = state.activity[key] ?? {}
    out.push({ date: key, qqbot: counts.qqbot ?? 0, onebot: counts.onebot ?? 0 })
  }
  return out
}

/** 人设/会话提示词单条长度上限（字符）。 */
export const MAX_PROMPT_CHARS = 5000

/** 归一化会话提示词：只留字符串、去掉空项、超长截断。 */
function normalizePrompt(raw) {
  const out = { default: '', chats: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  out.default = typeof raw.default === 'string' ? raw.default.slice(0, MAX_PROMPT_CHARS) : ''
  if (raw.chats !== null && typeof raw.chats === 'object' && !Array.isArray(raw.chats)) {
    for (const [chatKey, text] of Object.entries(raw.chats)) {
      if (typeof chatKey !== 'string' || chatKey === '' || typeof text !== 'string' || text.trim() === '') continue
      out.chats[chatKey] = text.slice(0, MAX_PROMPT_CHARS)
    }
  }
  return out
}

/** 人设 id 只允许小写字母/数字/下划线/短横线，最长 32。 */
export const PERSONA_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const MAX_PERSONA_STICKERS = 40
const PERSONA_STICKER_ID_RE = /^[a-f0-9]{64}$/

export function normalizePersonaStickerIds(raw, { strict = false } = {}) {
  const validId = id => typeof id === 'string' && PERSONA_STICKER_ID_RE.test(id)
  if (strict && (!Array.isArray(raw) || raw.some(id => !validId(id)))) {
    throw new Error('精选表情必须是图库 id 数组（64 位小写十六进制）')
  }
  const ids = [...new Set((Array.isArray(raw) ? raw : []).filter(validId))]
  if (strict && ids.length > MAX_PERSONA_STICKERS) throw new Error(`每个人设最多精选 ${MAX_PERSONA_STICKERS} 张表情`)
  return ids.slice(0, MAX_PERSONA_STICKERS)
}

/** 归一化人设库：只保留合法 id、非空文本与字符串名称，超长截断。 */
function normalizePersonas(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, entry] of Object.entries(raw)) {
    if (!PERSONA_ID_RE.test(id)) continue
    if (entry === null || typeof entry !== 'object' || typeof entry.text !== 'string' || entry.text.trim() === '') continue
    out[id] = {
      name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim().slice(0, 40) : id,
      text: entry.text.slice(0, MAX_PROMPT_CHARS),
      stickerIds: normalizePersonaStickerIds(entry.stickerIds),
      aliases: normalizeAliases(entry.aliases),
      activity: normalizeChatActivity(entry.activity),
      updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0,
    }
  }
  return out
}

/** 归一化默认人设 id：不存在的人设回落空（不静默保留悬空引用）。 */
function normalizeDefaultPersonaId(raw, personas) {
  const id = typeof raw === 'string' ? raw.trim() : ''
  return id !== '' && personas[id] !== undefined ? id : ''
}

/** 归一化对话→人设绑定：人设必须存在，chatKey 必须非空。 */
function normalizePersonaBindings(raw, personas) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [chatKey, entry] of Object.entries(raw)) {
    if (typeof chatKey !== 'string' || chatKey.trim() === '') continue
    const personaId = typeof entry === 'string' ? entry : entry?.personaId
    if (typeof personaId !== 'string' || personas[personaId] === undefined) continue
    out[chatKey] = { personaId, updatedAt: Number.isFinite(Number(entry?.updatedAt)) ? Number(entry.updatedAt) : 0 }
  }
  return out
}

function normalizePersonaModeBindings(raw, personas) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [chatKey, modes] of Object.entries(raw)) {
    if (typeof chatKey !== 'string' || chatKey.trim() === '') continue
    if (modes === null || typeof modes !== 'object' || Array.isArray(modes)) continue
    const entry = {}
    for (const mode of ['work', 'chat']) {
      const binding = modes[mode]
      const personaId = typeof binding === 'string' ? binding : binding?.personaId
      if (typeof personaId !== 'string' || personas[personaId] === undefined) continue
      entry[mode] = { personaId, updatedAt: Number.isFinite(Number(binding?.updatedAt)) ? Number(binding.updatedAt) : 0 }
    }
    if (Object.keys(entry).length > 0) out[chatKey] = entry
  }
  return out
}

function normalizePreferences(raw) {
  const out = { chats: {}, members: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (raw.chats !== null && typeof raw.chats === 'object' && !Array.isArray(raw.chats)) {
    for (const [chatKey, value] of Object.entries(raw.chats)) {
      if (typeof chatKey !== 'string' || value === null || typeof value !== 'object') continue
      out.chats[chatKey] = {
        proactiveUntil: Number.isFinite(Number(value.proactiveUntil)) ? Number(value.proactiveUntil) : 0,
        stickers: value.stickers !== false,
        activity: normalizeChatActivity(value.activity),
      }
    }
  }
  if (raw.members !== null && typeof raw.members === 'object' && !Array.isArray(raw.members)) {
    for (const [chatKey, people] of Object.entries(raw.members)) {
      if (typeof chatKey !== 'string' || people === null || typeof people !== 'object' || Array.isArray(people)) continue
      const rows = {}
      for (const [userId, value] of Object.entries(people)) {
        if (typeof userId !== 'string' || value === null || typeof value !== 'object') continue
        const name = typeof value.name === 'string' ? value.name.trim().slice(0, 40) : ''
        const proactiveUntil = Number.isFinite(Number(value.proactiveUntil)) ? Number(value.proactiveUntil) : 0
        if (name !== '' || proactiveUntil > 0) rows[userId] = { name, proactiveUntil }
      }
      if (Object.keys(rows).length > 0) out.members[chatKey] = rows
    }
  }
  return out
}

function normalizeSchedules(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const id = String(entry.id ?? '').trim()
    const chatKey = String(entry.chatKey ?? '').trim()
    if (id === '' || chatKey === '') continue
    const kind = entry.kind === 'daily' ? 'daily' : 'once'
    const time = typeof entry.time === 'string' ? entry.time : ''
    const at = Number(entry.at)
    if (kind === 'daily' && !/^\d{1,2}:\d{2}$/.test(time)) continue
    if (kind === 'once' && !Number.isFinite(at)) continue
    out.push({
      id,
      chatKey,
      transportKind: String(entry.transportKind ?? ''),
      accountId: String(entry.accountId ?? ''),
      target: entry.target !== null && typeof entry.target === 'object' ? clone(entry.target) : null,
      prompt: String(entry.prompt ?? '').slice(0, 2000),
      kind,
      time: kind === 'daily' ? time : '',
      at: kind === 'once' ? at : null,
      enabled: entry.enabled !== false,
      social: entry.social === true,
      createdBy: String(entry.createdBy ?? ''),
      createdAt: Number(entry.createdAt) || 0,
      lastRun: typeof entry.lastRun === 'string' ? entry.lastRun : '',
      lastError: typeof entry.lastError === 'string' ? entry.lastError : '',
    })
    if (out.length >= 100) break
  }
  return out
}

/** 审批历史的条数上限（内存/磁盘都只留这么多）。 */
export const APPROVAL_LOG_LIMIT = 50

/** 归一化审批历史：只保留有决策结果的条目，最多 APPROVAL_LOG_LIMIT 条。 */
function normalizeApprovals(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const decision = String(entry.decision ?? '')
    if (decision !== 'allow' && decision !== 'deny') continue
    out.push({
      at: Number(entry.at) || 0,
      chatKey: String(entry.chatKey ?? ''),
      decision,
      actorId: String(entry.actorId ?? ''),
      summary: String(entry.summary ?? '').slice(0, 300),
      approvalId: String(entry.approvalId ?? ''),
    })
    if (out.length >= APPROVAL_LOG_LIMIT) break
  }
  return out
}

/** 保留多少天的 token 用量：用户要求保留一个月。 */
export const USAGE_KEEP_DAYS = 31

/**
 * 归一化一次 token 用量（不同 provider 的字段名不一致）。
 * @param {unknown} raw - usage 对象，可能带 inputTokens/outputTokens/totalTokens（或下划线/语义别名）
 * @returns {{input: number, output: number, total: number}|null}
 */
export function normalizeUsageNumbers(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const pick = keys => {
    for (const key of keys) {
      const value = Number(Reflect.get(raw, key))
      if (Number.isFinite(value) && value >= 0) return Math.round(value)
    }
    return 0
  }
  const input = pick(['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const output = pick(['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  const total = pick(['totalTokens', 'total_tokens']) || input + output
  if (total <= 0) return null
  return { input, output, total }
}

/** 把磁盘上的 usage 归一化：只要数字、保留最近 USAGE_KEEP_DAYS 天。 */
function normalizeUsage(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const cutoff = Date.now() - USAGE_KEEP_DAYS * 86400_000
  for (const [date, chats] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || chats === null || typeof chats !== 'object' || Array.isArray(chats)) continue
    const parsed = Date.parse(`${date}T00:00:00`)
    if (Number.isFinite(parsed) && parsed < cutoff) continue
    const day = {}
    for (const [chatKey, cell] of Object.entries(chats)) {
      if (typeof chatKey !== 'string' || chatKey === '' || cell === null || typeof cell !== 'object') continue
      const input = Number(cell.in)
      const output = Number(cell.out)
      const total = Number(cell.total)
      const turns = Number(cell.turns)
      if (!Number.isFinite(total) || total <= 0) continue
      day[chatKey] = {
        in: Number.isFinite(input) && input > 0 ? Math.round(input) : 0,
        out: Number.isFinite(output) && output > 0 ? Math.round(output) : 0,
        total: Math.round(total),
        turns: Number.isFinite(turns) && turns > 0 ? Math.round(turns) : 1,
      }
    }
    if (Object.keys(day).length > 0) out[date] = day
  }
  return out
}

/** 近 N 天（含今天）的 token 序列，缺失的天补 0。 */
function usageSeries(state, days, at) {
  const out = []
  for (let index = days - 1; index >= 0; index -= 1) {
    const dayAt = at - index * 86400_000
    const key = activityDateKey(dayAt)
    const chats = state.usage[key] ?? {}
    const sum = { date: key, total: 0, input: 0, output: 0, turns: 0 }
    for (const cell of Object.values(chats)) {
      sum.total += cell.total
      sum.input += cell.in
      sum.output += cell.out
      sum.turns += cell.turns
    }
    out.push(sum)
  }
  return out
}


/**
 * 创建 store。
 * @param {object} options
 * @param {string} options.dir - 状态目录。
 * @param {string} [options.fileName] - 状态文件名。
 * @param {() => number} [options.clock]
 * @param {{warn: Function, info?: Function}} [options.logger]
 * @returns {object} store
 */
export function createStore({ dir, fileName = 'store.v1.json', clock = () => Date.now(), logger = null } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('createStore requires a dir')
  const file = join(dir, fileName)
  let state = emptyState()
  let loaded = false
  let writeChain = Promise.resolve()
  let lastRecovery = null
  // Only in-flight requests use these revisions. Refresh on every mutation/save,
  // so A -> B -> A still invalidates A, without cancelling unrelated scopes.
  const promptScopes = new Map()
  function refreshPromptScope(entry) {
    const signature = JSON.stringify([store.effectivePromptFor(entry.chatKey, entry.mode), store.effectiveBehaviorFor(entry.chatKey, entry.mode)])
    if (entry.signature !== signature) { entry.signature = signature; entry.revision += 1 }
    return entry.revision
  }

  const warn = message => {
    try {
      logger?.warn?.(message)
    } catch {
      /* 日志失败不影响状态机 */
    }
  }

  const ensureChat = chatKey => {
    let chat = state.chats[chatKey]
    if (chat === undefined) {
      chat = {
        currentSessionId: '',
        sessions: [],
        model: null,
        reasoning: null,
        lastTarget: null,
        mode: 'work',
        modeSessions: { work: '', chat: '' },
        sessionModes: {},
        updatedAt: 0,
      }
      state.chats[chatKey] = chat
    }
    if (!Array.isArray(chat.sessions)) chat.sessions = []
    if (chat.modeSessions === null || typeof chat.modeSessions !== 'object') chat.modeSessions = { work: '', chat: '' }
    if (chat.modeSessions.work === undefined) chat.modeSessions.work = ''
    if (chat.modeSessions.chat === undefined) chat.modeSessions.chat = ''
    if (chat.sessionModes === null || typeof chat.sessionModes !== 'object') chat.sessionModes = {}
    return chat
  }

  const atomicWrite = async text => {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  }

  /**
   * 微批写：同一事件循环轮次内的多次 save 合并成一次原子写。
   *
   * 为什么：QQ 高频时段一条入站消息 → activity + usage 至少两次写盘，
   * 每次都是「临时文件 + fsync + rename」。合并后既减少 IO，也避免写放大。
   * 语义仍然是「await save() 返回时数据已落盘」：同一批的 waiter 在写完后一起 resolve。
   *
   * 不用更长窗口的原因：连续 await 的保存（登录流程里 setAccountId → setHomeChannel）
   * 每步都卡窗口会让交互变慢；0ms 已经能合并同轮次的突发写入。
   */
  const SAVE_BATCH_MS = 0
  let saveTimer = null
  let saveWaiters = []
  let saveInFlight = null

  async function flushSave() {
    if (saveInFlight !== null) await saveInFlight
    if (saveWaiters.length === 0) return
    const waiters = saveWaiters
    saveWaiters = []
    state.meta.updatedAt = clock()
    const text = `${JSON.stringify(state, null, 2)}\n`
    // 关键：写链必须「接上去」而不是并行发起，否则两批同时 rename 会互相覆盖
    writeChain = writeChain
      .then(() => atomicWrite(text))
      .catch(error => {
        warn(`dsh-qq: store write failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    saveInFlight = writeChain
    await saveInFlight
    saveInFlight = null
    for (const resolve of waiters) resolve()
  }

  const save = () => new Promise(resolve => {
    for (const entry of promptScopes.values()) refreshPromptScope(entry)
    saveWaiters.push(resolve)
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void flushSave()
    }, SAVE_BATCH_MS)
  })

  const store = {
    /** 状态文件绝对路径（诊断用）。 */
    file,
    /** 立即落盘（卸载/退出前调用：微批窗口里的数据不能丢）。 */
    flushSave: async () => {
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      await flushSave()
    },
    get version() {
      return state.version
    },
    get loaded() {
      return loaded
    },
    get lastRecovery() {
      return lastRecovery
    },

    /**
     * 读取状态文件（不存在 → 空状态；损坏 → 备份并重建）。
     * @returns {Promise<{fresh: boolean, recovered: boolean}>}
     */
    async load() {
      loaded = true
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { fresh: true, recovered: false }
        throw error
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.chats !== 'object') {
          throw new TypeError('store root must be an object with a chats map')
        }
        state = {
          version: STORE_VERSION,
          chats: parsed.chats ?? {},
          pairing: {
            policy: parsed.pairing?.policy ?? 'pairing',
            roles: parsed.pairing?.roles ?? {},
            pending: Array.isArray(parsed.pairing?.pending) ? parsed.pairing.pending : [],
          },
          meta: { homeChannel: '', homeChannels: {}, accountId: '', updatedAt: 0, ...(parsed.meta ?? {}) },
          activity: normalizeActivity(parsed.activity),
          usage: normalizeUsage(parsed.usage),
          approvals: normalizeApprovals(parsed.approvals),
          prompt: normalizePrompt(parsed.prompt),
        }
        state.personas = normalizePersonas(parsed.personas)
        state.defaultPersonaId = normalizeDefaultPersonaId(parsed.defaultPersonaId, state.personas)
        state.personaBindings = normalizePersonaBindings(parsed.personaBindings, state.personas)
        state.personaModeBindings = normalizePersonaModeBindings(parsed.personaModeBindings, state.personas)
        state.schedules = normalizeSchedules(parsed.schedules)
        state.preferences = normalizePreferences(parsed.preferences)
        state.personaRevision = Number.isSafeInteger(parsed.personaRevision) ? parsed.personaRevision : 0
        state.personaRecent = Array.isArray(parsed.personaRecent)
          ? [...new Set(parsed.personaRecent.filter(id => typeof id === 'string' && state.personas[id] !== undefined))].slice(0, 8)
          : []
        state.personaFavorites = Array.isArray(parsed.personaFavorites)
          ? [...new Set(parsed.personaFavorites.filter(id => typeof id === 'string' && state.personas[id] !== undefined))].slice(0, 50)
          : []
        // 旧绑定迁移：先归入对话当前模式；另一模式由用户显式选择。迁移后清空旧字段，避免又变成“两模式共用”。
        for (const [chatKey, binding] of Object.entries(state.personaBindings)) {
          const mode = state.chats?.[chatKey]?.mode === 'chat' ? 'chat' : 'work'
          if (state.personaModeBindings[chatKey] === undefined) state.personaModeBindings[chatKey] = {}
          if (state.personaModeBindings[chatKey][mode] === undefined) state.personaModeBindings[chatKey][mode] = binding
        }
        state.personaBindings = {}
        // 身份按 transport 分区（v0.3.6）：旧的 homeChannel / roles 没有 transport 前缀，
        // 切到另一条线后主人与授权用户全部对不上（真机：切官方线后被判陌生人，且批准命令只有主人能发 → 锁死）。
        // 迁移规则：纯数字 → onebot（QQ 号）；其余（32 位 openid 等）→ qqbot。
        const migrateKindOf = value => (/^\d+$/.test(String(value ?? '').trim()) ? 'onebot' : 'qqbot')
        if (state.meta.homeChannels === null || typeof state.meta.homeChannels !== 'object' || Array.isArray(state.meta.homeChannels)) {
          state.meta.homeChannels = {}
        }
        if (state.meta.homeChannel !== '' && Object.keys(state.meta.homeChannels).length === 0) {
          state.meta.homeChannels[migrateKindOf(state.meta.homeChannel)] = state.meta.homeChannel
        }
        for (const [key, role] of Object.entries(state.pairing.roles)) {
          if (key.includes(':')) continue
          state.pairing.roles[`${migrateKindOf(key)}:${key}`] = role
          delete state.pairing.roles[key]
        }
        // 迁移/修复每个 chat 的形状
        for (const chatKey of Object.keys(state.chats)) {
          const chat = state.chats[chatKey]
          if (chat === null || typeof chat !== 'object') {
            state.chats[chatKey] = { currentSessionId: '', sessions: [], model: null, reasoning: null, lastTarget: null, mode: 'work', updatedAt: 0 }
            continue
          }
          if (!Array.isArray(chat.sessions)) chat.sessions = []
          if (chat.mode !== 'chat') chat.mode = 'work'
          if (chat.modeSessions === null || typeof chat.modeSessions !== 'object') chat.modeSessions = { work: '', chat: '' }
          if (chat.modeSessions.work === undefined) chat.modeSessions.work = ''
          if (chat.modeSessions.chat === undefined) chat.modeSessions.chat = ''
          if (chat.sessionModes === null || typeof chat.sessionModes !== 'object') chat.sessionModes = {}
          // 旧数据没有模式标记：当前会话归入当前模式，其余旧会话归 work（避免历史凭空消失）
          for (const entry of chat.sessions) {
            if (entry && typeof entry.sessionId === 'string' && entry.sessionId !== '' && chat.sessionModes[entry.sessionId] === undefined) {
              chat.sessionModes[entry.sessionId] = 'work'
            }
          }
          if (typeof chat.currentSessionId === 'string' && chat.currentSessionId !== '') {
            chat.sessionModes[chat.currentSessionId] = chat.mode
            chat.modeSessions[chat.mode] = chat.currentSessionId
          }
        }
        return { fresh: false, recovered: false }
      } catch (error) {
        const backup = `${file}.corrupt-${clock()}`
        lastRecovery = backup
        warn(`dsh-qq: store corrupted (${error instanceof Error ? error.message : String(error)}); backed up to ${backup}`)
        try {
          await rename(file, backup)
        } catch {
          /* 备份失败也要继续起 */
        }
        state = emptyState()
        return { fresh: true, recovered: true }
      }
    },

    /** 立即落盘（等待一次原子写完成）。 */
    save,

    // ── chat / session 指针 ─────────────────────────────────────────
    chat(chatKey) {
      return clone(ensureChat(chatKey))
    },
    /** 对话模式：work（默认）| chat（拟人化聊天）。 */
    modeFor(chatKey) {
      return state.chats[String(chatKey ?? '')]?.mode === 'chat' ? 'chat' : 'work'
    },
    /** 切换对话模式并落盘；currentSessionId 指向该模式自己的会话（没有则为空）。 */
    async setMode(chatKey, mode) {
      const key = String(chatKey ?? '').trim()
      if (key === '') throw new Error('chatKey 不能为空')
      const value = String(mode ?? '').trim()
      if (value !== 'work' && value !== 'chat') throw new Error('mode must be work or chat')
      const chat = ensureChat(key)
      chat.mode = value
      chat.currentSessionId = chat.modeSessions[value] ?? ''
      await save()
      return value
    },
    /** 某个模式绑定的会话 id；未绑定返回空串。 */
    modeSession(chatKey, mode) {
      const chat = state.chats[String(chatKey ?? '')]
      if (chat === undefined) return ''
      const value = mode === 'chat' ? 'chat' : 'work'
      return typeof chat.modeSessions?.[value] === 'string' ? chat.modeSessions[value] : ''
    },
    /** 某个会话属于哪个模式（旧数据默认 work）。 */
    sessionMode(chatKey, sessionId) {
      const chat = state.chats[String(chatKey ?? '')]
      if (chat === undefined) return 'work'
      return chat.sessionModes?.[String(sessionId ?? '')] === 'chat' ? 'chat' : 'work'
    },
    /** 当前对话的偏好（默认：主动开启、表情开启）。 */
    chatPreference(chatKey) {
      const value = state.preferences?.chats?.[String(chatKey ?? '')]
      return {
        proactiveUntil: Number(value?.proactiveUntil) || 0,
        stickers: value?.stickers !== false,
        activity: normalizeChatActivity(value?.activity),
      }
    },
    /** 设置当前对话偏好（patch：proactiveUntil/stickers/activity）。 */
    async setChatPreference(chatKey, patch = {}) {
      const key = String(chatKey ?? '').trim()
      if (key === '') throw new Error('chatKey 不能为空')
      const current = state.preferences.chats[key] ?? { proactiveUntil: 0, stickers: true }
      const next = {
        proactiveUntil: patch.proactiveUntil === undefined ? current.proactiveUntil : Math.max(0, Number(patch.proactiveUntil) || 0),
        stickers: patch.stickers === undefined ? current.stickers !== false : patch.stickers !== false,
        activity: patch.activity === undefined ? normalizeChatActivity(current.activity) : normalizeChatActivity(patch.activity, { strict: true }),
      }
      state.preferences.chats[key] = next
      if (next.activity !== normalizeChatActivity(current.activity)) state.personaRevision += 1
      await save()
      return clone(next)
    },
    /** 某个成员的称呼/主动静默。 */
    memberPreference(chatKey, userId) {
      const value = state.preferences?.members?.[String(chatKey ?? '')]?.[String(userId ?? '')]
      return { name: String(value?.name ?? ''), proactiveUntil: Number(value?.proactiveUntil) || 0 }
    },
    /** 设置成员偏好（name/proactiveUntil）。 */
    async setMemberPreference(chatKey, userId, patch = {}) {
      const chat = String(chatKey ?? '').trim()
      const member = String(userId ?? '').trim()
      if (chat === '' || member === '') throw new Error('chatKey 与 userId 不能为空')
      if (!state.preferences.members[chat]) state.preferences.members[chat] = {}
      const current = state.preferences.members[chat][member] ?? { name: '', proactiveUntil: 0 }
      const name = patch.name === undefined ? current.name : String(patch.name).trim().slice(0, 40)
      const proactiveUntil = patch.proactiveUntil === undefined ? current.proactiveUntil : Math.max(0, Number(patch.proactiveUntil) || 0)
      if (name === '' && proactiveUntil === 0) delete state.preferences.members[chat][member]
      else state.preferences.members[chat][member] = { name, proactiveUntil }
      await save()
      return store.memberPreference(chat, member)
    },
    /** 所有偏好（页面/诊断用，克隆）。 */
    preferences() {
      return clone(state.preferences)
    },
    /** 所有定时任务（克隆）。 */
    schedules() {
      return clone(state.schedules)
    },
    /** 新增定时任务（调用方负责字段校验/ID 生成）。 */
    async scheduleAdd(entry) {
      const task = normalizeSchedules([entry])[0]
      if (task === undefined) throw new Error('定时任务字段不合法')
      if (state.schedules.some(item => item.id === task.id)) throw new Error('定时任务 id 重复')
      if (state.schedules.length >= 100) throw new Error('全局定时任务已达上限（100）')
      const perChat = state.schedules.filter(item => item.chatKey === task.chatKey).length
      if (perChat >= 10) throw new Error('本对话定时任务已达上限（10）')
      state.schedules.push(task)
      await save()
      return clone(task)
    },
    /** 删除定时任务。 */
    async scheduleRemove(id) {
      const key = String(id ?? '').trim()
      const index = state.schedules.findIndex(item => item.id === key)
      if (index < 0) return false
      state.schedules.splice(index, 1)
      await save()
      return true
    },
    /** 记录一次任务结果（lastRun/lastError）。 */
    async scheduleMark(id, { lastRun = '', lastError = '' } = {}) {
      const task = state.schedules.find(item => item.id === String(id ?? ''))
      if (task === undefined) return false
      if (lastRun !== '') task.lastRun = String(lastRun)
      task.lastError = String(lastError ?? '').slice(0, 300)
      await save()
      return true
    },
    hasChat(chatKey) {
      return Object.prototype.hasOwnProperty.call(state.chats, chatKey)
    },
    chatKeys() {
      return Object.keys(state.chats)
    },
    stats() {
      const chats = Object.values(state.chats)
      return {
        chats: chats.length,
        sessions: chats.reduce((sum, chat) => sum + (Array.isArray(chat.sessions) ? chat.sessions.length : 0), 0),
        authorized: Object.keys(state.pairing.roles).length,
        version: state.version,
      }
    },

    async setCurrentSession(chatKey, sessionId, { title = '', at = clock(), mode = null, personaIdentity, contextEpoch = 0 } = {}) {
      const chat = ensureChat(chatKey)
      const targetMode = mode === 'chat' || mode === 'work' ? mode : chat.mode
      chat.currentSessionId = String(sessionId)
      chat.modeSessions[targetMode] = chat.currentSessionId
      chat.sessionModes[chat.currentSessionId] = targetMode
      if (typeof personaIdentity === 'string') {
        chat.sessionBindings ??= {}
        chat.sessionBindings[chat.currentSessionId] = { mode: targetMode, personaIdentity, contextEpoch }
      }
      chat.updatedAt = at
      const existing = chat.sessions.find(entry => entry.sessionId === chat.currentSessionId)
      if (existing === undefined) {
        chat.sessions.unshift({ sessionId: chat.currentSessionId, title: String(title), createdAt: at, lastAt: at })
      } else {
        existing.lastAt = at
        if (title !== '') existing.title = String(title)
      }
      chat.sessions = chat.sessions.slice(0, MAX_RECENT_SESSIONS)
      await save()
      return clone(chat)
    },

    sessionBinding(chatKey, sessionId) {
      return clone(state.chats[chatKey]?.sessionBindings?.[sessionId] ?? null)
    },

    sessionRestorable(chatKey, sessionId, { mode, personaIdentity, minContextEpoch = 0 } = {}) {
      const binding = state.chats[chatKey]?.sessionBindings?.[sessionId]
      return !!binding && binding.mode === mode && binding.personaIdentity === personaIdentity
        && Number.isSafeInteger(binding.contextEpoch) && binding.contextEpoch >= minContextEpoch
    },

    async clearCurrentSession(chatKey, mode) {
      const chat = ensureChat(chatKey)
      const targetMode = mode === 'chat' ? 'chat' : 'work'
      chat.modeSessions[targetMode] = ''
      if (chat.mode === targetMode) chat.currentSessionId = ''
      await save()
    },

    async switchSession(chatKey, index, { at = clock(), mode = '' } = {}) {
      const chat = ensureChat(chatKey)
      const want = mode === 'chat' || mode === 'work' ? mode : ''
      const list = want === ''
        ? chat.sessions
        : [...chat.sessions].filter(entry => chat.sessionModes?.[entry.sessionId] === want)
      if (!Number.isSafeInteger(index) || index < 0 || index >= list.length) return null
      const target = list[index]
      chat.currentSessionId = target.sessionId
      if (want !== '') chat.modeSessions[want] = target.sessionId
      target.lastAt = at
      chat.updatedAt = at
      await save()
      return clone(target)
    },

    sessions(chatKey, mode = '') {
      const chat = state.chats[chatKey]
      if (chat === undefined) return []
      const want = mode === 'chat' || mode === 'work' ? mode : ''
      const list = want === ''
        ? chat.sessions
        : chat.sessions.filter(entry => chat.sessionModes?.[entry.sessionId] === want)
      return clone([...list].sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0)))
    },

    async setSelection(chatKey, { model = undefined, reasoning = undefined, at = clock() } = {}) {
      const chat = ensureChat(chatKey)
      if (model !== undefined) chat.model = model === null ? null : String(model)
      if (reasoning !== undefined) chat.reasoning = reasoning === null ? null : String(reasoning)
      chat.updatedAt = at
      await save()
      return clone(chat)
    },

    async touch(chatKey, { target = undefined, at = clock() } = {}) {
      const chat = ensureChat(chatKey)
      if (target !== undefined) chat.lastTarget = target === null ? null : clone(target)
      chat.updatedAt = at
      await save()
      return clone(chat)
    },

    async removeChat(chatKey) {
      if (!Object.prototype.hasOwnProperty.call(state.chats, chatKey)) return false
      delete state.chats[chatKey]
      await save()
      return true
    },

    // ── 授权 / 角色 ────────────────────────────────────────────────
    /**
     * 某 transport 的主人 id。
     * 分区表为空时回落到历史全局值（未迁移的老 store / 单协议部署），
     * 分区表非空但该 transport 没绑定时返回空——这正是「切到另一条线不该沿用另一条线主人」的语义。
     * @param {string|null} transportKind
     */
    homeChannelOf(transportKind) {
      if (transportKind === null || transportKind === undefined || transportKind === '') {
        return String(state.meta.homeChannels?.onebot ?? state.meta.homeChannel ?? '')
      }
      const kind = String(transportKind)
      const perKind = String(state.meta.homeChannels?.[kind] ?? '')
      if (perKind !== '') return perKind
      if (Object.keys(state.meta.homeChannels ?? {}).length === 0) return String(state.meta.homeChannel ?? '')
      return ''
    },

    /**
     * 角色判定。
     * @param {string} userId
     * @param {string|null} [transportKind] - 传入时按该 transport 的 homeChannel/授权记录判定；
     *   不传则走旧的全局语义（未迁移的调用方/测试）。
     */
    roleOf(userId, transportKind = null) {
      const id = String(userId ?? '')
      if (id === '') return 'everyone'
      if (transportKind !== null && transportKind !== undefined && transportKind !== '') {
        const kind = String(transportKind)
        const home = store.homeChannelOf(kind)
        if (home !== '' && id === home) return 'owner'
        // 有前缀的记录优先；没有时回落旧的无前缀记录（迁移前的授权）
        return state.pairing.roles[`${kind}:${id}`] ?? state.pairing.roles[id] ?? 'everyone'
      }
      if (state.meta.homeChannel !== '' && id === state.meta.homeChannel) return 'owner'
      if (state.pairing.roles[id] !== undefined) return state.pairing.roles[id]
      // 兼容无 transport 上下文的调用方（旧调用/测试）：唯一的前缀记录也能查到；
      // 同一个 id 出现在多条线时没法判断，返回 everyone（宁可让调用方显式传 kind）。
      const hits = Object.entries(state.pairing.roles).filter(([key]) => key.endsWith(`:${id}`))
      return hits.length === 1 ? hits[0][1] : 'everyone'
    },
    isAuthorized(userId, transportKind = null) {
      return store.roleOf(userId, transportKind) !== 'everyone'
    },
    authorizedList(transportKind = null) {
      const prefix = transportKind === null || transportKind === undefined || transportKind === '' ? '' : `${String(transportKind)}:`
      return Object.entries(state.pairing.roles)
        .filter(([id]) => (prefix === '' ? true : id.startsWith(prefix)))
        .map(([id, role]) => ({ id: prefix === '' ? id : id.slice(prefix.length), role }))
    },
    pairingPolicy() {
      return state.pairing.policy
    },
    async setPairingPolicy(policy) {
      state.pairing.policy = String(policy)
      await save()
    },
    async addAuthorized(userId, { role = 'authorized', transportKind = null } = {}) {
      const id = String(userId ?? '').trim()
      if (id === '') throw new TypeError('addAuthorized requires a userId')
      const key = transportKind === null || transportKind === undefined || transportKind === '' ? id : `${String(transportKind)}:${id}`
      state.pairing.roles[key] = role
      state.pairing.pending = state.pairing.pending.filter(entry => entry.id !== id)
      await save()
      return { id, role, transportKind: transportKind === undefined ? null : transportKind }
    },
    async removeAuthorized(userId, transportKind = null) {
      const id = String(userId ?? '').trim()
      const key = transportKind === null || transportKind === undefined || transportKind === '' ? id : `${String(transportKind)}:${id}`
      const existed = Object.prototype.hasOwnProperty.call(state.pairing.roles, key)
      delete state.pairing.roles[key]
      if (existed) await save()
      return existed
    },
    pendingPairing() {
      return clone(state.pairing.pending)
    },
    /** 删除一条待批配对（Web 配置页的「拒绝」按钮）。 */
    async removePendingPairing(userId) {
      const id = String(userId ?? '').trim()
      const before = state.pairing.pending.length
      state.pairing.pending = state.pairing.pending.filter(entry => entry.id !== id)
      const removed = state.pairing.pending.length !== before
      if (removed) await save()
      return removed
    },
    /**
     * 记录一条配对申请。
     * @param {object} spec
     * @param {string} spec.userId
     * @param {string} [spec.name]
     * @param {number} [spec.at]
     * @param {{text: string, target: object}|null} [spec.message]
     *   触发申请的那条消息（只留文本 + 目标；**不留媒体 URL**——那是带鉴权的临时链接）。
     *   批准时用它补答首条消息，否则陌生人必须把问题再发一遍才有回应。
     */
    async addPendingPairing({ userId, name = '', at = clock(), message = null, transportKind = null, accountId = '' }) {
      const id = String(userId ?? '').trim()
      if (id === '') return null
      const roleKey = transportKind === null || transportKind === undefined || transportKind === '' ? id : `${String(transportKind)}:${id}`
      const pendingKind = transportKind === null || transportKind === undefined || transportKind === '' ? null : String(transportKind)
      const pendingAccount = String(accountId ?? '').trim()
      if (state.pairing.roles[roleKey] !== undefined) return null
      const kept =
        message !== null && typeof message === 'object' && typeof message.text === 'string' && message.text !== ''
          ? { text: message.text, target: clone(message.target) }
          : null
      const existing = state.pairing.pending.find(entry => entry.id === id)
      if (existing !== undefined) {
        existing.lastAt = at
        existing.name = name || existing.name
        if (pendingKind !== null) existing.transportKind = pendingKind
        if (pendingAccount !== '') existing.accountId = pendingAccount
        if (kept !== null) existing.message = kept
        await save()
        return clone(existing)
      }
      const entry = {
        id,
        name,
        firstAt: at,
        lastAt: at,
        ...(pendingKind === null ? {} : { transportKind: pendingKind }),
        ...(pendingAccount === '' ? {} : { accountId: pendingAccount }),
        ...(kept === null ? {} : { message: kept }),
      }
      state.pairing.pending.push(entry)
      await save()
      return clone(entry)
    },

    // ── meta ──────────────────────────────────────────────────────
    /**
     * 主人频道（私聊 id）。
     * @param {string|null} [transportKind] - 传入时读该 transport 的绑定；不传返回 onebot（历史默认）再退全局。
     */
    homeChannel(transportKind = null) {
      return store.homeChannelOf(transportKind)
    },
    async setHomeChannel(userId, transportKind = null) {
      const id = String(userId ?? '')
      if (transportKind !== null && transportKind !== undefined && transportKind !== '') {
        state.meta.homeChannels = { ...(state.meta.homeChannels ?? {}), [String(transportKind)]: id }
        // 兼容字段：onebot 的主人是历史默认语义
        if (String(transportKind) === 'onebot' || state.meta.homeChannel === '') state.meta.homeChannel = id
      } else {
        state.meta.homeChannel = id
      }
      await save()
    },
    /** 合并写入 meta（诊断字段如 lastResumeError 也放这里，便于外部排查）。 */
    async setMeta(patch) {
      state.meta = { ...state.meta, ...patch }
      await save()
      return clone(state.meta)
    },
    accountId() {
      return state.meta.accountId
    },
    async setAccountId(accountId) {
      state.meta.accountId = String(accountId ?? '')
      await save()
    },
    /**
     * 记录一条入站消息（按线路、按天）。控制台「近 7 天活动量」用。
     * 计数在内存里累加后立刻落盘：QQ 消息频率很低，写入开销可忽略；
     * 这样重启后趋势不会清零。
     * @param {string} transportKind - 'qqbot' | 'onebot' | 其它
     * @param {number} [at]
     */
    async recordActivity(transportKind, at = clock()) {
      const kind = String(transportKind ?? '').trim()
      if (kind === '') return null
      const key = activityDateKey(at)
      const day = state.activity[key] ?? {}
      day[kind] = (day[kind] ?? 0) + 1
      state.activity[key] = day
      // 顺手裁掉过期天数（只在写时判断，避免 load 之后的长期运行无限增长）
      if (Object.keys(state.activity).length > ACTIVITY_KEEP_DAYS + 5) {
        state.activity = normalizeActivity(state.activity)
      }
      await save()
      return day[kind]
    },
    /** 默认 system prompt（对所有 QQ 对话生效；空串表示不注入）。 */
    defaultPrompt() {
      return state.prompt.default
    },
    /** 某个对话自己的 system prompt（没有则空串）。 */
    chatPrompt(chatKey) {
      return state.prompt.chats[String(chatKey ?? '')] ?? ''
    },
    /**
     * 生效人设：精确对话绑定 > 旧对话提示词 > 默认人设 > 旧默认提示词。
     * 返回来源，控制台/命令用来说明「为什么生效的是这段」。
     */
    effectivePromptFor(chatKey, mode = '') {
      const key = String(chatKey ?? '')
      const currentMode = mode === 'chat' || mode === 'work'
        ? mode
        : (state.chats?.[key]?.mode === 'chat' ? 'chat' : 'work')
      const modeBinding = state.personaModeBindings?.[key]?.[currentMode]
      const binding = modeBinding ?? state.personaBindings[key]
      if (binding !== undefined) {
        const persona = state.personas[binding.personaId]
        if (persona !== undefined) {
          return {
            text: persona.text,
            source: 'binding',
            personaId: binding.personaId,
            personaName: persona.name,
            stickerIds: [...(persona.stickerIds ?? [])],
            aliases: [...(persona.aliases ?? [])],
            activity: normalizeChatActivity(persona.activity),
            mode: currentMode,
          }
        }
      }
      const chatPrompt = state.prompt.chats[key]
      if (typeof chatPrompt === 'string' && chatPrompt.trim() !== '') return { text: chatPrompt, source: 'chat', aliases: [], activity: 'inherit' }
      const defaultPersona = state.personas[state.defaultPersonaId]
      if (defaultPersona !== undefined) {
        return { text: defaultPersona.text, source: 'defaultPersona', personaId: state.defaultPersonaId, personaName: defaultPersona.name, stickerIds: [...(defaultPersona.stickerIds ?? [])], aliases: [...(defaultPersona.aliases ?? [])], activity: normalizeChatActivity(defaultPersona.activity) }
      }
      if (state.prompt.default !== '') return { text: state.prompt.default, source: 'default', aliases: [], activity: 'inherit' }
      return { text: '', source: 'none', aliases: [], activity: 'inherit' }
    },
    /** 群行为覆盖优先于生效人设；inherit 继续使用全局配置，不改全局值。 */
    effectiveBehaviorFor(chatKey, mode = 'chat', { persona } = {}) {
      const effective = persona === undefined ? store.effectivePromptFor(chatKey, mode)
        : { aliases: normalizeAliases(persona?.aliases), activity: normalizeChatActivity(persona?.activity) }
      const activity = store.chatPreference(chatKey).activity
      if (activity !== 'inherit') return { aliases: [...effective.aliases], activity, source: 'chat' }
      if (effective.activity !== 'inherit') return { aliases: [...effective.aliases], activity: effective.activity, source: 'persona' }
      return { aliases: [...effective.aliases], activity: 'inherit', source: 'global' }
    },
    /** 兼容旧调用：返回生效文本。 */
    promptFor(chatKey, mode = '') {
      return store.effectivePromptFor(chatKey, mode).text
    },
    /** 人设列表（按最近更新倒序）。 */
    personaList() {
      return Object.entries(state.personas)
        .map(([id, persona]) => ({ id, name: persona.name, chars: persona.text.length, updatedAt: persona.updatedAt, stickerCount: (persona.stickerIds ?? []).length, aliases: [...(persona.aliases ?? [])], activity: normalizeChatActivity(persona.activity) }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    /** 单个人设（不存在返回 null）。 */
    personaOf(id) {
      const key = String(id ?? '')
      const persona = state.personas[key]
      return persona === undefined ? null : { ...clone(persona), id: key, stickerIds: [...(persona.stickerIds ?? [])] }
    },
    /** 默认人设 id（没有则空串）。 */
    defaultPersonaId() {
      return state.defaultPersonaId
    },
    /** 旧版所有对话→人设绑定（迁移后为空，保留兼容）。 */
    personaBindings() {
      return clone(state.personaBindings)
    },
    /** 所有对话→按模式的人设绑定。 */
    personaModeBindings() {
      return clone(state.personaModeBindings)
    },
    /** 当前人设/提示词版本（每次变更 +1，用于作废旧出站）。 */
    promptRevision(chatKey, mode = '') {
      if (chatKey === undefined) return state.personaRevision
      const currentMode = mode === 'chat' || mode === 'work' ? mode : store.modeFor(chatKey)
      const key = JSON.stringify([chatKey, currentMode])
      if (!promptScopes.has(key)) promptScopes.set(key, { chatKey, mode: currentMode, signature: '', revision: 0 })
      return refreshPromptScope(promptScopes.get(key))
    },

    personaIdentityFor(chatKey, mode = '') {
      const effective = store.effectivePromptFor(chatKey, mode)
      return effective.personaId ?? ({ chat: 'legacy:chat', default: 'legacy:default' }[effective.source] ?? 'legacy:none')
    },
    /** 最近使用的人设 id（全局）。 */
    personaRecentList() {
      return [...state.personaRecent]
    },
    /** 收藏的人设 id（全局）。 */
    personaFavoriteList() {
      return [...state.personaFavorites]
    },
    /** 收藏/取消收藏人设；返回是否已收藏。 */
    async togglePersonaFavorite(id) {
      const key = String(id ?? '').trim()
      if (state.personas[key] === undefined) throw new Error(`人设不存在：${key}`)
      const index = state.personaFavorites.indexOf(key)
      if (index >= 0) state.personaFavorites.splice(index, 1)
      else state.personaFavorites = [key, ...state.personaFavorites].slice(0, 50)
      await save()
      return index < 0
    },
    /** 某个对话某个模式绑定的人设 id（没有则空串）。 */
    personaBinding(chatKey, mode = '') {
      const key = String(chatKey ?? '')
      const currentMode = mode === 'chat' || mode === 'work'
        ? mode
        : (state.chats?.[key]?.mode === 'chat' ? 'chat' : 'work')
      const binding = state.personaModeBindings?.[key]?.[currentMode] ?? state.personaBindings[key]
      return binding === undefined ? '' : binding.personaId
    },
    /** 记录一次人设使用（内部；调用方负责 save）。 */
    rememberPersonaUse(id) {
      const key = String(id ?? '').trim()
      if (key === '' || state.personas[key] === undefined) return
      state.personaRecent = [key, ...state.personaRecent.filter(item => item !== key)].slice(0, 8)
    },

    /** 新建/更新人设；id 必须合法，文本不能为空或超长。 */
    async setPersona(id, { name = '', text: body = '', stickerIds, aliases, activity } = {}) {
      const key = String(id ?? '').trim()
      if (!PERSONA_ID_RE.test(key)) throw new Error('人设 id 只能用小写字母/数字/下划线/短横线，且以字母或数字开头（最长 32）')
      const value = String(body ?? '')
      if (value.trim() === '') throw new Error('人设内容不能为空')
      if (value.length > MAX_PROMPT_CHARS) throw new Error(`人设太长（${value.length} > ${MAX_PROMPT_CHARS} 字）`)
      const selected = stickerIds === undefined
        ? [...(state.personas[key]?.stickerIds ?? [])]
        : normalizePersonaStickerIds(stickerIds, { strict: true })
      const label = String(name ?? '').trim()
      const nicknames = aliases === undefined ? [...(state.personas[key]?.aliases ?? [])] : normalizeAliases(aliases, { strict: true })
      const level = activity === undefined ? normalizeChatActivity(state.personas[key]?.activity) : normalizeChatActivity(activity, { strict: true })
      state.personas[key] = {
        name: label === '' ? key : label.slice(0, 40),
        text: value,
        stickerIds: selected,
        aliases: nicknames,
        activity: level,
        updatedAt: Date.now(),
      }
      state.personaRevision += 1
      await save()
      return store.personaOf(key)
    },
    /** 删除人设：同时清默认引用与所有绑定。 */
    async removePersona(id) {
      const key = String(id ?? '')
      if (state.personas[key] === undefined) return false
      delete state.personas[key]
      for (const chat of Object.values(state.chats)) {
        for (const [sessionId, binding] of Object.entries(chat.sessionBindings ?? {})) {
          if (binding.personaIdentity === key) delete chat.sessionBindings[sessionId]
        }
      }
      if (state.defaultPersonaId === key) state.defaultPersonaId = ''
      state.personaRecent = state.personaRecent.filter(item => item !== key)
      state.personaFavorites = state.personaFavorites.filter(item => item !== key)
      state.personaRevision += 1
      for (const [chatKey, binding] of Object.entries(state.personaBindings)) {
        if (binding.personaId === key) delete state.personaBindings[chatKey]
      }
      for (const [chatKey, modes] of Object.entries(state.personaModeBindings)) {
        for (const mode of ['work', 'chat']) {
          if (modes?.[mode]?.personaId === key) delete modes[mode]
        }
        if (Object.keys(modes).length === 0) delete state.personaModeBindings[chatKey]
      }
      await save()
      return true
    },
    /** 设置默认人设；空串 = 取消。 */
    async setDefaultPersona(id) {
      const key = String(id ?? '').trim()
      if (key !== '' && state.personas[key] === undefined) throw new Error(`人设不存在：${key}`)
      state.defaultPersonaId = key
      state.personaRevision += 1
      if (key !== '') store.rememberPersonaUse(key)
      await save()
      return key
    },
    /**
     * 绑定/解绑对话人设；绑定会清掉该对话的旧 prompt 覆盖，避免两个来源同时存在。
     * @param {string} chatKey
     * @param {string} personaId - 空串 = 解绑
     */
    async bindPersona(chatKey, personaId, mode = '') {
      const key = String(chatKey ?? '').trim()
      if (key === '') throw new Error('chatKey 不能为空')
      const currentMode = mode === 'chat' || mode === 'work'
        ? mode
        : (state.chats?.[key]?.mode === 'chat' ? 'chat' : 'work')
      const id = String(personaId ?? '').trim()
      if (!state.personaModeBindings[key]) state.personaModeBindings[key] = {}
      if (id === '') {
        delete state.personaModeBindings[key][currentMode]
        if (Object.keys(state.personaModeBindings[key]).length === 0) delete state.personaModeBindings[key]
      } else {
        if (state.personas[id] === undefined) throw new Error(`人设不存在：${id}`)
        state.personaModeBindings[key][currentMode] = { personaId: id, updatedAt: Date.now() }
        store.rememberPersonaUse(id)
        delete state.prompt.chats[key]
      }
      delete state.personaBindings[key]
      state.personaRevision += 1
      await save()
      return id
    },
    /** 清除对话绑定（回落到旧对话提示词/默认人设）。 */
    async clearPersonaBinding(chatKey, mode = '') {
      const key = String(chatKey ?? '').trim()
      if (key === '') throw new Error('chatKey 不能为空')
      const currentMode = mode === 'chat' || mode === 'work'
        ? mode
        : (state.chats?.[key]?.mode === 'chat' ? 'chat' : 'work')
      let changed = false
      if (state.personaModeBindings[key]?.[currentMode] !== undefined) {
        delete state.personaModeBindings[key][currentMode]
        if (Object.keys(state.personaModeBindings[key]).length === 0) delete state.personaModeBindings[key]
        changed = true
      }
      if (state.personaBindings[key] !== undefined) {
        delete state.personaBindings[key]
        changed = true
      }
      if (changed) {
        state.personaRevision += 1
        await save()
      }
      return changed
    },
    /** 所有对话级覆盖（chatKey → 文本），控制台列表用。 */
    promptChats() {
      return { ...state.prompt.chats }
    },
    /** 设置默认提示词；空串 = 清除。 */
    async setDefaultPrompt(text) {
      const value = String(text ?? '')
      if (value.length > MAX_PROMPT_CHARS) throw new Error(`system prompt 太长（${value.length} > ${MAX_PROMPT_CHARS} 字）`)
      state.prompt.default = value
      await save()
      return value
    },
    /** 设置/清除某个对话的提示词（空串删除覆盖，回到默认）。 */
    async setChatPrompt(chatKey, text) {
      const key = String(chatKey ?? '').trim()
      if (key === '') throw new Error('chatKey 不能为空')
      const value = String(text ?? '')
      if (value.length > MAX_PROMPT_CHARS) throw new Error(`system prompt 太长（${value.length} > ${MAX_PROMPT_CHARS} 字）`)
      if (value.trim() === '') delete state.prompt.chats[key]
      else {
        state.prompt.chats[key] = value
        // 旧编辑器显式写对话提示词 = 用户最后一次动作，清掉所有人设绑定避免被覆盖
        delete state.personaBindings[key]
        delete state.personaModeBindings[key]
        state.personaRevision += 1
      }
      await save()
      return value
    },
    /**
     * 记录一条审批结果（控制台「最近审批」用）。
     * 只存决策元数据（谁/哪个会话/允许还是拒绝），不存审批正文，避免敏感命令留在磁盘上。
     * @param {{at?: number, chatKey?: string, decision: string, actorId?: string, summary?: string, approvalId?: string}} entry
     */
    async recordApproval(entry) {
      const decision = String(entry?.decision ?? '')
      if (decision !== 'allow' && decision !== 'deny') return null
      state.approvals.unshift({
        at: Number(entry?.at) || Date.now(),
        chatKey: String(entry?.chatKey ?? ''),
        decision,
        actorId: String(entry?.actorId ?? ''),
        summary: String(entry?.summary ?? '').slice(0, 300),
        approvalId: String(entry?.approvalId ?? ''),
      })
      if (state.approvals.length > APPROVAL_LOG_LIMIT) state.approvals.length = APPROVAL_LOG_LIMIT
      await save()
      return state.approvals[0]
    },
    /** 最近审批（新→旧）。 */
    approvalsRecent(limit = 20) {
      const count = Math.max(1, Math.min(APPROVAL_LOG_LIMIT, Number(limit) || 20))
      return state.approvals.slice(0, count)
    },
    /**
     * 记录一次 token 用量（按对话、按天）。
     *
     * 归属：chatKey 天然带目标（私聊 = 某个人，群聊 = 某个群），所以按 chatKey 累计就是
     * 「每个人 / 每个群」的消耗；一轮里多步会产生多条 assistant/message，逐条累加。
     * 写入即落盘（QQ 消息频率低，开销可忽略），并按 USAGE_KEEP_DAYS 裁掉旧数据。
     * @param {string} chatKey
     * @param {{inputTokens?: number, outputTokens?: number, totalTokens?: number}|object} usage
     * @param {number} [at]
     * @returns {Promise<object|null>} 当天该对话的新计数，或 null（无效数据）
     */
    async recordUsage(chatKey, usage, at = clock()) {
      const key = String(chatKey ?? '').trim()
      if (key === '') return null
      const numbers = normalizeUsageNumbers(usage)
      if (numbers === null) return null
      const date = activityDateKey(at)
      const day = state.usage[date] ?? {}
      const cell = day[key] ?? { in: 0, out: 0, total: 0, turns: 0 }
      cell.in += numbers.input
      cell.out += numbers.output
      cell.total += numbers.total
      cell.turns += 1
      day[key] = cell
      state.usage[date] = day
      if (Object.keys(state.usage).length > USAGE_KEEP_DAYS + 5) {
        state.usage = normalizeUsage(state.usage)
      }
      await save()
      return cell
    },
    /**
     * Token 用量报表（最近 N 天，含今天）：按天序列 + 按对话聚合 + 今日/近7天/近30天合计。
     * @param {{days?: number, at?: number}} [options]
     * @returns {{span: number, days: Array<object>, chats: Array<object>, totals: {today: object, week: object, month: object}}}
     */
    usageReport({ days = USAGE_KEEP_DAYS, at = clock() } = {}) {
      const span = Math.max(1, Math.min(USAGE_KEEP_DAYS, Number(days) || USAGE_KEEP_DAYS))
      const series = usageSeries(state, span, at)
      const dates = new Set(series.map(entry => entry.date))
      const chats = new Map()
      for (const entry of series) {
        for (const [chatKey, cell] of Object.entries(state.usage[entry.date] ?? {})) {
          const row = chats.get(chatKey) ?? { chatKey, total: 0, input: 0, output: 0, turns: 0, days: {} }
          row.total += cell.total
          row.input += cell.in
          row.output += cell.out
          row.turns += cell.turns
          row.days[entry.date] = { total: cell.total, input: cell.in, output: cell.out }
          chats.set(chatKey, row)
        }
      }
      const sumRange = count => {
        const slice = series.slice(Math.max(0, series.length - count))
        const out = { total: 0, input: 0, output: 0, turns: 0 }
        for (const entry of slice) {
          out.total += entry.total
          out.input += entry.input
          out.output += entry.output
          out.turns += entry.turns
        }
        return out
      }
      return {
        span,
        days: series,
        chats: [...chats.values()].sort((a, b) => b.total - a.total),
        totals: { today: sumRange(1), week: sumRange(7), month: sumRange(span) },
        dates: [...dates],
      }
    },
    /**
     * 近 N 天活动序列（含今天，缺失补 0）。
     * @param {number} [days]
     * @param {number} [at]
     * @returns {Array<{date: string, qqbot: number, onebot: number}>}
     */
    activity(days = 7, at = clock()) {
      return activitySeries(state, Math.max(1, Math.min(30, Number(days) || 7)), at)
    },
    snapshot() {
      return clone(state)
    },
  }

  return store
}

export default createStore
