/**
 * 配置解析与权限策略（执行文档 §5.7）。
 *
 * 无 schema 依赖：手写校验（约 100 行，避免为几个字段引入 schemastery）。
 * 配置来源优先级：apply(ctx, rawConfig)（= profile 行 config）> 默认值。
 * 会话凭据等敏感项走 DSH credentials/settings seam（P4），不进配置文件。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 角色阶梯（越大权限越高）。 */
export const ROLE_RANK = Object.freeze({ everyone: 0, authorized: 1, admin: 2, owner: 3 })
export const ROLES = Object.freeze(Object.keys(ROLE_RANK))

/** 可授权的动作域。 */
export const POLICY_ACTIONS = Object.freeze(['chat', 'sessionControl', 'modelControl', 'approvals'])

/** 传输实现（新增一种接入方式在这里登记即可）。 */
export const TRANSPORT_KINDS = Object.freeze(['qqbot', 'mock'])

/** 配对策略。 */
export const PAIRING_POLICIES = Object.freeze(['pairing', 'open', 'allowlist'])

export const DEFAULTS = Object.freeze({
  /** 传输实现：qqbot（官方）/ mock（本地调试，不连 QQ）。 */
  transport: 'qqbot',
  /** 插件加载后是否自动连接。 */
  autoConnect: true,
  /** 断线看门狗间隔（毫秒）：启动期凭据竞态/重连耗尽后自动复活（0 由校验拒绝）。 */
  watchdogIntervalMs: 5000,
  /** 账号命名空间（qqbot=AppID；登录后回填；mock 用固定值）。 */
  accountId: '',
  /** QQ portal host（沙箱：sandbox.q.qq.com）。 */
  portalHost: 'q.qq.com',
  /** 新会话工作目录；空 = 进程 cwd。 */
  cwd: '',
  /** 新会话 agent preset；空 = DSH 默认。 */
  agentPreset: '',
  /** 状态文件目录；空 = $DSH_HOME/qq-adapter。 */
  dataDir: '',
  /** 每 chat 在途消息上限（有界 inbox，评审 §12）。 */
  maxQueuedMessagesPerChat: 8,
  /** 回合运行中到达的消息投递方式：steer=在本回合下一个步边界交给模型（默认）；
   *  queue=沿用 followup，独占一个新回合，需等本轮结束。 */
  midTurnDelivery: 'steer',
  /** 单条消息媒体数量上限。 */
  maxMediaPerMessage: 8,
  /** 单文件字节上限。 */
  maxFileBytes: 25 * 1024 * 1024,
  /** 审批等待超时（毫秒）。 */
  approvalTtlMs: 5 * 60 * 1000,
  /** 被动回复窗口（毫秒，QQ 官方 5 分钟）。 */
  replyWindowMs: 5 * 60 * 1000,
  /** 消息去重窗口（毫秒）。 */
  dedupWindowMs: 5 * 60 * 1000,
  /** 去重表容量。 */
  dedupMaxSize: 1000,
  /** markdown 开关：auto（按 transport capabilities）| on | off。 */
  markdown: 'auto',
  /** 入站授权策略。 */
  pairingPolicy: 'pairing',
  /** 远程控制权限（评审 §8：与聊天授权分离）。 */
  controlPolicy: Object.freeze({
    chat: 'authorized',
    sessionControl: 'owner',
    modelControl: 'owner',
    approvals: 'owner',
  }),
  /** 群聊/频道是否必须 @ 机器人才回应（关掉或加白名单可让群里所有消息都回）。 */
  mentionRequired: true,
  /** 免 @ 的群白名单（群号），仅对群聊生效。 */
  freeReplyGroups: Object.freeze([]),
  /** 语音转写（P5）：provider/baseUrl/model/apiKey 由 credentials 提供。 */
  stt: Object.freeze({ provider: '', baseUrl: '', model: '' }),
  /** 新会话的 agentOptions（provider/model/maxTokens），null = 用 DSH 默认。 */
  agentOptions: null,
})

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  return value
}

function assertPositiveInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function assertEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`)
  }
  return value
}

function assertString(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  return value
}

/**
 * 解析 controlPolicy。
 * @param {object} [raw]
 * @returns {{chat: string, sessionControl: string, modelControl: string, approvals: string}}
 */
export function resolveControlPolicy(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('controlPolicy must be an object')
  }
  const unknown = Object.keys(raw).filter(key => !POLICY_ACTIONS.includes(key))
  if (unknown.length > 0) throw new TypeError(`controlPolicy has unknown keys: ${unknown.join(', ')}`)
  const policy = {}
  for (const action of POLICY_ACTIONS) {
    const value = raw[action] ?? DEFAULTS.controlPolicy[action]
    policy[action] = assertEnum(value, `controlPolicy.${action}`, ROLES)
  }
  return Object.freeze(policy)
}

/**
 * 角色是否满足某动作域的最低权限。
 * @param {object} policy - resolveControlPolicy 结果。
 * @param {'chat'|'sessionControl'|'modelControl'|'approvals'} action
 * @param {string} role - 'owner'|'admin'|'authorized'|'everyone'
 * @returns {boolean}
 */
export function roleAllows(policy, action, role) {
  const required = policy?.[action] ?? DEFAULTS.controlPolicy[action] ?? 'authorized'
  const have = ROLE_RANK[role] ?? 0
  const need = ROLE_RANK[required] ?? 1
  return have >= need
}

/**
 * 解析并校验插件配置。
 * @param {object} [raw] - profile 行 config（可为空）。
 * @returns {object} 冻结后的完整配置。
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-qq config must be an object')
  }
  const known = new Set(Object.keys(DEFAULTS))
  const unknown = Object.keys(raw).filter(key => !known.has(key))
  if (unknown.length > 0) throw new TypeError(`dsh-qq config has unknown keys: ${unknown.join(', ')}`)

  const merged = { ...DEFAULTS, ...raw }
  const config = {
    transport: assertEnum(merged.transport, 'transport', TRANSPORT_KINDS),
    autoConnect: assertBoolean(merged.autoConnect, 'autoConnect'),
    watchdogIntervalMs: assertPositiveInt(merged.watchdogIntervalMs, 'watchdogIntervalMs', { min: 100 }),
    accountId: assertString(merged.accountId, 'accountId'),
    portalHost: assertString(merged.portalHost, 'portalHost'),
    cwd: assertString(merged.cwd, 'cwd'),
    agentPreset: assertString(merged.agentPreset, 'agentPreset'),
    dataDir: assertString(merged.dataDir, 'dataDir'),
    maxQueuedMessagesPerChat: assertPositiveInt(merged.maxQueuedMessagesPerChat, 'maxQueuedMessagesPerChat', { min: 1, max: 64 }),
    midTurnDelivery: assertEnum(merged.midTurnDelivery, 'midTurnDelivery', ['steer', 'queue']),
    maxMediaPerMessage: assertPositiveInt(merged.maxMediaPerMessage, 'maxMediaPerMessage', { min: 1, max: 64 }),
    maxFileBytes: assertPositiveInt(merged.maxFileBytes, 'maxFileBytes', { min: 1024 }),
    approvalTtlMs: assertPositiveInt(merged.approvalTtlMs, 'approvalTtlMs', { min: 1000 }),
    replyWindowMs: assertPositiveInt(merged.replyWindowMs, 'replyWindowMs', { min: 1000 }),
    dedupWindowMs: assertPositiveInt(merged.dedupWindowMs, 'dedupWindowMs', { min: 1000 }),
    dedupMaxSize: assertPositiveInt(merged.dedupMaxSize, 'dedupMaxSize', { min: 8 }),
    markdown: assertEnum(merged.markdown, 'markdown', ['auto', 'on', 'off']),
    mentionRequired: assertBoolean(merged.mentionRequired, 'mentionRequired'),
    freeReplyGroups: resolveStringList(merged.freeReplyGroups, 'freeReplyGroups'),
    pairingPolicy: assertEnum(merged.pairingPolicy, 'pairingPolicy', PAIRING_POLICIES),
    controlPolicy: resolveControlPolicy(merged.controlPolicy ?? {}),
    stt: resolveStt(merged.stt ?? {}),
    agentOptions: resolveAgentOptions(merged.agentOptions),
  }
  if (config.transport === 'qqbot') {
    if (config.accountId.includes(':')) throw new TypeError('accountId must not contain ":"')
  }
  return Object.freeze({ ...config, dataDir: config.dataDir || defaultDataDir() })
}

/** 解析 STT 配置。 */
function resolveStt(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('stt must be an object')
  const stt = {
    provider: assertString(raw.provider ?? '', 'stt.provider'),
    baseUrl: assertString(raw.baseUrl ?? '', 'stt.baseUrl'),
    model: assertString(raw.model ?? '', 'stt.model'),
  }
  return Object.freeze(stt)
}

/**
 * 解析字符串数组配置（去空、去重、保持顺序）。
 * @param {unknown} raw
 * @param {string} field
 * @returns {ReadonlyArray<string>}
 */
export function resolveStringList(raw, field) {
  if (raw === undefined || raw === null) return Object.freeze([])
  if (!Array.isArray(raw)) throw new TypeError(`${field} must be an array of strings`)
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') throw new TypeError(`${field} must contain non-empty strings`)
    seen.add(item.trim())
  }
  return Object.freeze([...seen])
}

/** 解析新会话 agentOptions（null 或 {provider, model, maxTokens?}）。 */
export function resolveAgentOptions(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('agentOptions must be null or an object')
  const unknown = Object.keys(raw).filter(key => !['provider', 'model', 'maxTokens', 'reasoningEffort'].includes(key))
  if (unknown.length > 0) throw new TypeError(`agentOptions has unknown keys: ${unknown.join(', ')}`)
  const options = {}
  if (raw.provider !== undefined) options.provider = assertString(raw.provider, 'agentOptions.provider')
  if (raw.model !== undefined) options.model = assertString(raw.model, 'agentOptions.model')
  if (raw.reasoningEffort !== undefined) options.reasoningEffort = assertString(raw.reasoningEffort, 'agentOptions.reasoningEffort')
  if (raw.maxTokens !== undefined) options.maxTokens = assertPositiveInt(raw.maxTokens, 'agentOptions.maxTokens')
  return Object.freeze(options)
}

/** 默认状态目录：$DSH_HOME/qq-adapter（回退 ~/.dsh/qq-adapter）。 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, 'qq-adapter')
}

/** 凭据引用名（DSH credentials seam 用 POSIX 环境变量名寻址）。 */
export const CREDENTIAL_REFS = Object.freeze({
  appId: 'QQ_APP_ID',
  clientSecret: 'QQ_CLIENT_SECRET',
})

/**
 * 解析凭据：credentials 服务（推荐）→ 环境变量（开发回退）。
 * 绝不把 secret 写进日志。
 * @param {object} ctx
 * @returns {Promise<{appId: string, clientSecret: string, source: string}|null>}
 */
export async function resolveCredentials(ctx) {
  const credentials = ctx?.get?.('credentials')
  const usable = credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function'
  const read = async ref => {
    if (!usable) return ''
    try {
      const hit = await credentials.resolve(ref)
      return typeof hit?.value === 'string' ? hit.value.trim() : ''
    } catch {
      return ''
    }
  }
  const appId = (await read(CREDENTIAL_REFS.appId)) || String(process.env.QQ_APP_ID ?? '').trim()
  const clientSecret = (await read(CREDENTIAL_REFS.clientSecret)) || String(process.env.QQ_CLIENT_SECRET ?? '').trim()
  if (appId === '' || clientSecret === '') return null
  return { appId, clientSecret, source: usable ? 'credentials' : 'environment' }
}

/**
 * 保存凭据到 credentials 服务（P4 扫码登录、手动凭据入口都走这里）。
 * 无 credentials 服务时如实报错——绝不退化成明文落盘。
 * @param {object} ctx
 * @param {{appId: string, clientSecret: string}} credentials
 */
export async function saveCredentials(ctx, { appId, clientSecret }) {
  const credentials = ctx?.get?.('credentials')
  if (credentials === undefined || credentials === null || typeof credentials.set !== 'function') {
    throw new Error('当前部署没有 credentials 服务，无法安全保存凭据；请改用环境变量或设置页配置')
  }
  if (String(appId ?? '') === '' || String(clientSecret ?? '') === '') {
    throw new TypeError('saveCredentials 需要非空 appId 与 clientSecret')
  }
  await credentials.set(CREDENTIAL_REFS.appId, String(appId))
  await credentials.set(CREDENTIAL_REFS.clientSecret, String(clientSecret))
}

/** 清除本地凭据。 */
export async function clearCredentials(ctx) {
  const credentials = ctx?.get?.('credentials')
  if (credentials === undefined || credentials === null || typeof credentials.unset !== 'function') return false
  let removed = false
  for (const ref of [CREDENTIAL_REFS.appId, CREDENTIAL_REFS.clientSecret]) {
    try {
      await credentials.unset(ref)
      removed = true
    } catch {
      /* 单个失败不影响另一个 */
    }
  }
  return removed
}

/** 该 chat 是否被允许发起普通对话（聊天授权 + ACL）。 */
export function chatAllowed(config, store, senderId) {
  if (config.pairingPolicy === 'open') return true
  const role = store.roleOf(senderId)
  if (role !== 'everyone') return true
  return false
}
