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

/** 传输实现（新增实现只需在此登记）。 */
export const TRANSPORT_KINDS = Object.freeze(['qqbot', 'mock'])

/** 配对策略。 */
export const PAIRING_POLICIES = Object.freeze(['pairing', 'open', 'allowlist'])

/** 群记忆配置的合法键（多余键直接报错，避免"写了不生效"的假配置）。 */
const GROUP_MEMORY_KEYS = Object.freeze(['enabled', 'bufferMessages', 'contextMaxChars', 'notesMaxChars'])
/** 掉线提醒配置的合法键。 */
const ALERTS_KEYS = Object.freeze(['enabled', 'notify', 'downAfterMs', 'cooldownMs'])
const MEDIA_KEYS = Object.freeze(['allowedHosts', 'allowPrivateHosts', 'tokenHosts', 'maxRedirects'])

export const DEFAULTS = Object.freeze({
  /** 传输实现：qqbot（官方）/ mock（本地调试，不连 QQ）。 */
  transport: 'qqbot',
  /**
   * 线路列表：数组元素 { kind, accountId?, enabled? }；省略则由单 transport + accountId 生成一条线。
   * 保留这一层是为了让「单线路」与将来的多线路共用同一条代码路径。
   */
  transports: null,
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
  /** 媒体下载边界：默认只允许公网地址；私网/自建源需显式列出。 */
  media: Object.freeze({
    /** 额外允许的主机（host / host:port / *.example.com）；命中后跳过私网拦截。 */
    allowedHosts: Object.freeze([]),
    /** 允许解析到私网/回环地址（默认 false；自建源通常用 allowedHosts 精确放行）。 */
    allowPrivateHosts: false,
    /** 额外允许携带鉴权头的主机（默认只给 transport 自己的源站带 token）。 */
    tokenHosts: Object.freeze([]),
    /** 最多跟随几次重定向（每次都会重新校验主机/私网）。 */
    maxRedirects: 3,
  }),
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
  /** 群聊/频道是否必须 @ 机器人才回应。 */
  mentionRequired: true,
  /** 免 @ 的群白名单（群号），仅对群聊生效。 */
  freeReplyGroups: Object.freeze([]),
  /** 语音转写（P5）：provider/baseUrl/model/apiKey 由 credentials 提供。 */
  stt: Object.freeze({ provider: '', baseUrl: '', model: '' }),
  /** 新会话的 agentOptions（provider/model/maxTokens），null = 用 DSH 默认。 */
  agentOptions: null,
  /**
   * 群记忆：热闹群里「长期约定/梗/知识」不丢，又不把上下文炸掉。
   * 三层都是**零额外 LLM 调用**：环境缓冲（内存）→ 被 @ 时注入最近消息 → 群专属笔记（落盘、模型用
   * qq_group_note 工具维护）。刻意不做全量归档：那会无界增长并把别人的聊天记录永久落盘。
   */
  /** 可选价格表（每百万 token，人民币元）；0 = 不换算，页面只显示 token 数。 */
  pricing: Object.freeze({ inputPerMillion: 0, outputPerMillion: 0 }),
  alerts: Object.freeze({
    enabled: true,
    notify: true,
    downAfterMs: 60_000,
    cooldownMs: 600_000,
  }),
  groupMemory: Object.freeze({
    enabled: true,
    /** 每个群的环形缓冲条数（所有入站群消息，含未 @ 机器人的）。 */
    bufferMessages: 100,
    /** 每次被 @ 时注入的「群最近消息」字符预算（超出丢最旧的并如实告知）。 */
    contextMaxChars: 1200,
    /** 群笔记文件容量上限（也是注入上限）：写超了拒绝落盘，逼模型自己收敛。 */
    notesMaxChars: 2000,
  }),
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

/** 解析媒体下载边界（host 白名单 / 私网放行 / token 白名单 / 重定向上限）。 */
function resolveMedia(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('media must be an object')
  const unknown = Object.keys(raw).filter(key => !MEDIA_KEYS.includes(key))
  if (unknown.length > 0) throw new TypeError(`media has unknown keys: ${unknown.join(', ')}`)
  return Object.freeze({
    allowedHosts: resolveStringList(raw.allowedHosts ?? [], 'media.allowedHosts'),
    allowPrivateHosts: raw.allowPrivateHosts === undefined ? false : assertBoolean(raw.allowPrivateHosts, 'media.allowPrivateHosts'),
    tokenHosts: resolveStringList(raw.tokenHosts ?? [], 'media.tokenHosts'),
    maxRedirects: raw.maxRedirects === undefined ? 3 : assertPositiveInt(raw.maxRedirects, 'media.maxRedirects', { min: 0, max: 10 }),
  })
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
  const transports = resolveTransports(merged.transports, merged)
  const config = {
    // 单线兼容：transport 取第一条线路（多线路时真正的线路列表在 transports 里）
    transport: transports[0].kind,
    transports,
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
    media: resolveMedia(merged.media ?? {}),
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
    groupMemory: resolveGroupMemory(merged.groupMemory ?? {}),
    alerts: resolveAlerts(merged.alerts ?? {}),
    pricing: resolvePricing(merged.pricing ?? {}),
  }
  if (config.transport === 'qqbot') {
    if (config.accountId.includes(':')) throw new TypeError('accountId must not contain ":"')
  }
  return Object.freeze({ ...config, dataDir: config.dataDir || defaultDataDir() })
}

/**
 * 解析线路列表。
 * - 省略 transports（null/undefined）→ 由单 transport + accountId 生成一条线；
 * - 传入数组 → 校验每项 { kind, accountId?, enabled? }，kind 不重复（同协议多账号暂不支持）。
 * @param {unknown} raw
 * @param {object} merged - 合并默认值后的原始配置（读取 transport/accountId）
 * @returns {ReadonlyArray<object>} 冻结后的线路列表
 */
function resolveTransports(raw, merged) {
  if (raw === null || raw === undefined) {
    return Object.freeze([
      Object.freeze({
        kind: assertEnum(merged.transport, 'transport', TRANSPORT_KINDS),
        accountId: assertString(merged.accountId, 'accountId'),
        enabled: true,
      }),
    ])
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TypeError('transports 必须是非空数组（省略则以 transport 单线运行）')
  }
  const seen = new Set()
  const specs = raw.map((spec, index) => {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError(`transports[${index}] 必须是对象`)
    }
    const unknown = Object.keys(spec).filter(key => !['kind', 'accountId', 'enabled'].includes(key))
    if (unknown.length > 0) throw new TypeError(`transports[${index}] has unknown keys: ${unknown.join(', ')}`)
    const kind = assertEnum(spec.kind, `transports[${index}].kind`, TRANSPORT_KINDS)
    if (seen.has(kind)) throw new TypeError(`transports 里有重复线路：${kind}（同一协议多账号暂不支持）`)
    seen.add(kind)
    return Object.freeze({
      kind,
      accountId: spec.accountId === undefined ? '' : assertString(spec.accountId, `transports[${index}].accountId`),
      enabled: spec.enabled === undefined ? true : assertBoolean(spec.enabled, `transports[${index}].enabled`),
    })
  })
  if (specs.every(spec => spec.enabled === false)) {
    throw new TypeError('transports 不能全部 enabled:false（至少启用一条线路）')
  }
  return Object.freeze(specs)
}

/**
 * 解析掉线提醒配置。
 * - enabled：总开关；notify：是否额外用 QQ 私聊通知主人（页面告警条始终生效）；
 * - downAfterMs：连续掉线多久才提醒（防抖，避免网络抖动刷屏）；
 * - cooldownMs：同一条线两次提醒的最小间隔。
 * @param {object} raw
 * @returns {object} 冻结后的 alerts
 */
const PRICING_KEYS = Object.freeze(['inputPerMillion', 'outputPerMillion'])

/** 解析价格表：只接受非负有限数；未知键报错（避免「写了不生效」）。 */
function resolvePricing(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('pricing must be an object')
  for (const key of Object.keys(raw)) {
    if (!PRICING_KEYS.includes(key)) throw new TypeError(`未知的 pricing 配置项：${key}`)
  }
  const number = (value, fallback, field) => {
    if (value === undefined || value === null) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError(`pricing.${field} 必须是非负数`)
    return parsed
  }
  return {
    inputPerMillion: number(raw.inputPerMillion, DEFAULTS.pricing.inputPerMillion, 'inputPerMillion'),
    outputPerMillion: number(raw.outputPerMillion, DEFAULTS.pricing.outputPerMillion, 'outputPerMillion'),
  }
}

function resolveAlerts(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('alerts must be an object')
  const unknown = Object.keys(raw).filter(key => !ALERTS_KEYS.includes(key))
  if (unknown.length > 0) throw new TypeError(`alerts has unknown keys: ${unknown.join(', ')}`)
  const downAfterMs = raw.downAfterMs === undefined ? DEFAULTS.alerts.downAfterMs : raw.downAfterMs
  const cooldownMs = raw.cooldownMs === undefined ? DEFAULTS.alerts.cooldownMs : raw.cooldownMs
  return Object.freeze({
    enabled: raw.enabled === undefined ? true : assertBoolean(raw.enabled, 'alerts.enabled'),
    notify: raw.notify === undefined ? true : assertBoolean(raw.notify, 'alerts.notify'),
    downAfterMs: assertPositiveInt(downAfterMs, 'alerts.downAfterMs', { min: 5_000, max: 3_600_000 }),
    cooldownMs: assertPositiveInt(cooldownMs, 'alerts.cooldownMs', { min: 60_000, max: 24 * 3_600_000 }),
  })
}

/**
 * 解析群记忆配置（三层都零额外 LLM 调用；默认开启，可用 enabled=false 整体关掉）。
 * @param {object} raw
 * @returns {object} 冻结后的 groupMemory
 */
function resolveGroupMemory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('groupMemory must be an object')
  const unknown = Object.keys(raw).filter(key => !GROUP_MEMORY_KEYS.includes(key))
  if (unknown.length > 0) throw new TypeError(`groupMemory has unknown keys: ${unknown.join(', ')}`)
  return Object.freeze({
    enabled: raw.enabled === undefined ? true : assertBoolean(raw.enabled, 'groupMemory.enabled'),
    bufferMessages: assertPositiveInt(raw.bufferMessages ?? 100, 'groupMemory.bufferMessages', { min: 1, max: 2000 }),
    contextMaxChars: assertPositiveInt(raw.contextMaxChars ?? 1200, 'groupMemory.contextMaxChars', { min: 100, max: 20000 }),
    notesMaxChars: assertPositiveInt(raw.notesMaxChars ?? 2000, 'groupMemory.notesMaxChars', { min: 200, max: 20000 }),
  })
}

/** 解析 STT 配置。 */
function resolveStt(raw) {  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('stt must be an object')
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
 * 通用凭据读取：credentials 服务（推荐）→ 环境变量。
 * 值可能合法地为空，所以不在这里判空报错。
 * @param {object} ctx
 * @param {Array<string>} refs - 要读取的引用名
 * @returns {Promise<Record<string, string>>} 引用名 → 值（缺失为 ''）
 */
export async function resolveOnboardingCredentials(ctx, refs) {
  const credentials = ctx?.get?.('credentials')
  const usable = credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function'
  const result = {}
  for (const ref of Array.isArray(refs) ? refs : []) {
    let value = ''
    if (usable) {
      try {
        const hit = await credentials.resolve(ref)
        if (typeof hit?.value === 'string') value = hit.value.trim()
      } catch {
        value = ''
      }
    }
    if (value === '') value = String(process.env[ref] ?? '').trim()
    result[ref] = value
  }
  return result
}

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
export function chatAllowed(config, store, senderId, transportKind = null) {
  if (config.pairingPolicy === 'open') return true
  const role = store.roleOf(senderId, transportKind)
  if (role !== 'everyone') return true
  return false
}
