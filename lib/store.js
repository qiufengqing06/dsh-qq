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

export const STORE_VERSION = 1
/** 每个 chat 保留的最近会话数。 */
export const MAX_RECENT_SESSIONS = 10

function emptyState() {
  return {
    version: STORE_VERSION,
    chats: {},
    pairing: { policy: 'pairing', roles: {}, pending: [] },
    meta: { homeChannel: '', homeChannels: {}, accountId: '', updatedAt: 0 },
    // 按天、按线路的消息计数（控制台「近 7 天活动量」用）：{ 'YYYY-MM-DD': { qqbot: n } }
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
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}
/** system prompt 单条长度上限（字符）：再长就不是「人设」，而是把整篇文档塞进系统提示。 */
export const MAX_PROMPT_CHARS = 4000

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
    out.push({ date: key, qqbot: counts.qqbot ?? 0 })
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
      chat = { currentSessionId: '', sessions: [], model: null, reasoning: null, lastTarget: null, updatedAt: 0 }
      state.chats[chatKey] = chat
    }
    if (!Array.isArray(chat.sessions)) chat.sessions = []
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
        // 身份按 transport 分区（v0.3.6）：旧的 homeChannel / roles 没有 transport 前缀，
        // 切到另一条线后主人与授权用户全部对不上（真机：切官方线后被判陌生人，且批准命令只有主人能发 → 锁死）。
        // 旧 store 的身份没有 transport 前缀：本仓库只有官方线，统一迁移到 qqbot。
        const migrateKindOf = () => 'qqbot'
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
            state.chats[chatKey] = { currentSessionId: '', sessions: [], model: null, reasoning: null, lastTarget: null, updatedAt: 0 }
            continue
          }
          if (!Array.isArray(chat.sessions)) chat.sessions = []
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

    async setCurrentSession(chatKey, sessionId, { title = '', at = clock() } = {}) {
      const chat = ensureChat(chatKey)
      chat.currentSessionId = String(sessionId)
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

    async switchSession(chatKey, index, { at = clock() } = {}) {
      const chat = ensureChat(chatKey)
      if (!Number.isSafeInteger(index) || index < 0 || index >= chat.sessions.length) return null
      const target = chat.sessions[index]
      chat.currentSessionId = target.sessionId
      target.lastAt = at
      chat.updatedAt = at
      await save()
      return clone(target)
    },

    sessions(chatKey) {
      const chat = state.chats[chatKey]
      if (chat === undefined) return []
      return clone([...chat.sessions].sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0)))
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
        return String(state.meta.homeChannel ?? '')
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
    async addPendingPairing({ userId, name = '', at = clock(), message = null, transportKind = null }) {
      const id = String(userId ?? '').trim()
      if (id === '') return null
      const roleKey = transportKind === null || transportKind === undefined || transportKind === '' ? id : `${String(transportKind)}:${id}`
      const pendingKind = transportKind === null || transportKind === undefined || transportKind === '' ? null : String(transportKind)
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
        if (kept !== null) existing.message = kept
        await save()
        return clone(existing)
      }
      const entry = { id, name, firstAt: at, lastAt: at, ...(pendingKind === null ? {} : { transportKind: pendingKind }), ...(kept === null ? {} : { message: kept }) }
      state.pairing.pending.push(entry)
      await save()
      return clone(entry)
    },

    // ── meta ──────────────────────────────────────────────────────
    /**
     * 主人频道（私聊 id）。
     * @param {string|null} [transportKind] - 传入时读该 transport 的绑定；不传返回全局值。
     */
    homeChannel(transportKind = null) {
      return store.homeChannelOf(transportKind)
    },
    async setHomeChannel(userId, transportKind = null) {
      const id = String(userId ?? '')
      if (transportKind !== null && transportKind !== undefined && transportKind !== '') {
        state.meta.homeChannels = { ...(state.meta.homeChannels ?? {}), [String(transportKind)]: id }
        // 兼容字段：全局 homeChannel 保留最近一次绑定的值
        if (state.meta.homeChannel === '') state.meta.homeChannel = id
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
     * @param {string} transportKind - 'qqbot' | 其它
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
    /** 生效值：对话覆盖 > 默认。 */
    promptFor(chatKey) {
      const key = String(chatKey ?? '')
      return state.prompt.chats[key] ?? state.prompt.default
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
      else state.prompt.chats[key] = value
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
    /**
     * 近 N 天活动序列（含今天，缺失补 0）。
     * @param {number} [days]
     * @param {number} [at]
     * @returns {Array<{date: string, qqbot: number}>}
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
