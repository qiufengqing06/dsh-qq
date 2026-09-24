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
    meta: { homeChannel: '', accountId: '', updatedAt: 0 },
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
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

  const save = () => {
    state.meta.updatedAt = clock()
    const text = `${JSON.stringify(state, null, 2)}\n`
    writeChain = writeChain.then(() => atomicWrite(text)).catch(error => {
      warn(`dsh-qq: store write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return writeChain
  }

  const store = {
    /** 状态文件绝对路径（诊断用）。 */
    file,
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
          meta: { homeChannel: '', accountId: '', updatedAt: 0, ...(parsed.meta ?? {}) },
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
    roleOf(userId) {
      const id = String(userId ?? '')
      if (id === '') return 'everyone'
      if (state.meta.homeChannel !== '' && id === state.meta.homeChannel) return 'owner'
      return state.pairing.roles[id] ?? 'everyone'
    },
    isAuthorized(userId) {
      return store.roleOf(userId) !== 'everyone'
    },
    authorizedList() {
      return Object.entries(state.pairing.roles).map(([id, role]) => ({ id, role }))
    },
    pairingPolicy() {
      return state.pairing.policy
    },
    async setPairingPolicy(policy) {
      state.pairing.policy = String(policy)
      await save()
    },
    async addAuthorized(userId, { role = 'authorized' } = {}) {
      const id = String(userId ?? '').trim()
      if (id === '') throw new TypeError('addAuthorized requires a userId')
      state.pairing.roles[id] = role
      state.pairing.pending = state.pairing.pending.filter(entry => entry.id !== id)
      await save()
      return { id, role }
    },
    async removeAuthorized(userId) {
      const id = String(userId ?? '').trim()
      const existed = Object.prototype.hasOwnProperty.call(state.pairing.roles, id)
      delete state.pairing.roles[id]
      if (existed) await save()
      return existed
    },
    pendingPairing() {
      return clone(state.pairing.pending)
    },
    async addPendingPairing({ userId, name = '', at = clock() }) {
      const id = String(userId ?? '').trim()
      if (id === '') return null
      if (state.pairing.roles[id] !== undefined) return null
      const existing = state.pairing.pending.find(entry => entry.id === id)
      if (existing !== undefined) {
        existing.lastAt = at
        existing.name = name || existing.name
        await save()
        return clone(existing)
      }
      const entry = { id, name, firstAt: at, lastAt: at }
      state.pairing.pending.push(entry)
      await save()
      return clone(entry)
    },

    // ── meta ──────────────────────────────────────────────────────
    homeChannel() {
      return state.meta.homeChannel
    },
    async setHomeChannel(userId) {
      state.meta.homeChannel = String(userId ?? '')
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
    snapshot() {
      return clone(state)
    },
  }

  return store
}

export default createStore
