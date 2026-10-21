/**
 * 线路 transport 注册表（官方 QQBot；测试里可用 mock 实现）。
 *
 * 设计上支持多条线路（每条线路是独立的 QQ 身份，各有各的入站事件与会话）；
 * 插件上层（router/bridge/control）本来就按 chatKey 的
 * `${transportKind}:${accountId}:…` 命名空间工作，所以线路层只需要一层路由：
 *
 * - 出站：`sendText(target, …)` 按 target 找到它属于哪条线路（target→kind 索引）；
 *   索引在启动时从 store 的历史对话（lastTarget）冷启动，之后每条入站消息刷新，
 *   所以插件重载后即使还没收到新消息，也能把主动消息发回正确的线路。
 * - 入站：每条线路各注册一个 onMessage，事件本身已带 chatKey/transportKind，直接透传。
 * - 状态：聚合出一个 `status()`（沿用单 transport 字段，`connected` 表示「至少一条线通」），
 *   同时用 `lines()` 暴露每条线路的真实状态（控制台/诊断用）。
 * - 能力：`capabilities()` 返回「最近入站线路」的能力（没有入站时取第一条）；
 *   需要按目标判断时用 `capabilitiesFor(target)`，避免把一条线路的能力套到另一条上。
 *
 * 单线路部署（`transport: 'qqbot'` 不写 `transports`）行为与旧版完全一致：注册表里只有一条线，
 * 所有路由都退化为「那一条」。
 */

import { parseChatKey, targetKey } from './transport.js'

/** transport 模块加载表（新增协议只需新增一行 + 一个文件）。 */
export const TRANSPORT_LOADERS = Object.freeze({
  mock: () => import('./mock.js'),
  qqbot: () => import('./qqbot.js'),
})

const messageOf = error => (error instanceof Error ? error.message : String(error))

/**
 * 把配置展开成「每线路一份 config」。
 * - `transports` 数组优先（过滤 `enabled: false`）；
 * - 否则退回单 `transport`（旧配置完全兼容）。
 * @param {object} config - resolveConfig 结果
 * @returns {Array<{kind: string, config: object}>}
 */
export function expandLineSpecs(config) {
  const specs = Array.isArray(config.transports) && config.transports.length > 0 ? config.transports : null
  const lines = specs === null
    ? [{ kind: config.transport, accountId: config.accountId ?? '' }]
    : specs.filter(spec => spec.enabled !== false).map(spec => ({ kind: spec.kind, accountId: spec.accountId ?? '' }))
  return lines.map(spec =>
    Object.freeze({
      kind: spec.kind,
      // 每条线路用自己那份 config：transport=kind 决定加载哪个实现，accountId 可per-line 覆盖
      config: Object.freeze({ ...config, transport: spec.kind, accountId: spec.accountId === '' ? config.accountId : spec.accountId }),
    }),
  )
}

/**
 * 加载一条线路的 transport（模块缺失/构造失败时降级为 unavailable，不拖垮整个插件）。
 * @param {object} spec
 * @param {object} spec.ctx
 * @param {object} spec.config - 该线路的 config（transport 已固定）
 * @param {object} spec.scope
 * @param {object} spec.log
 * @returns {Promise<object>} transport
 */
export async function loadLineTransport({ ctx, config, scope, log }) {
  const kind = config.transport
  const loader = TRANSPORT_LOADERS[kind]
  const unavailable = reason => createUnavailable(kind, reason)
  if (loader === undefined) return unavailable(`未知 transport: ${kind}`)
  // 测试注入口（可选服务）：让集成测试把 transport 指向假 QQ 服务，不影响生产路径。
  const deps = ctx.get?.('dshQqTransportDeps') ?? {}
  try {
    const module = await loader()
    const factory = module.createTransport ?? module.default
    if (typeof factory !== 'function') throw new TypeError('transport 模块未导出 createTransport')
    const transport = await factory({ config, ctx, scope, logger: ctx.logger ?? null, deps })
    log.info(`dsh-qq: transport ${kind} 已加载`)
    return transport
  } catch (error) {
    const reason = messageOf(error)
    log.warn(`dsh-qq: transport ${kind} 不可用（${reason}）——该线路降级`)
    return unavailable(reason)
  }
}

/** 延迟 import 的 unavailable 实现（避免与 transport.js 形成加载期循环依赖）。 */
function createUnavailable(kind, reason) {
  // 这里同步构造：unavailable transport 只是一组返回失败的对象，没有异步初始化
  const status = () => ({ connected: false, phase: 'unavailable', kind, lastError: reason, accountId: '' })
  const fail = async () => ({ ok: false, error: reason })
  return {
    kind,
    capabilities: () => ({ markdown: false, keyboard: false, typing: false, media: [], passiveReply: false, proactiveMessage: false }),
    start: async () => false,
    stop: async () => {},
    status,
    onMessage: () => () => {},
    onInteraction: () => () => {},
    sendText: fail,
    sendMedia: fail,
    sendKeyboard: fail,
    sendTyping: fail,
    downloadMedia: fail,
    hasCredentials: () => false,
  }
}

/**
 * 创建多线路注册表。
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.config - resolveConfig 结果
 * @param {object} deps.scope
 * @param {object} deps.log
 * @param {object} deps.store - 用于冷启动 target→线路 索引
 * @param {Function} [deps.loadTransport] - 测试钩子
 * @returns {Promise<object>} registry
 */
export async function createTransportRegistry({ ctx, config, scope, log, store, loadTransport = loadLineTransport }) {
  const lines = []
  for (const spec of expandLineSpecs(config)) {
    if (lines.some(line => line.kind === spec.kind)) throw new TypeError(`transports 里有重复线路：${spec.kind}`)
    const transport = await loadTransport({ ctx, config: spec.config, scope, log })
    lines.push({ kind: spec.kind, transport, config: spec.config })
  }
  if (lines.length === 0) throw new TypeError('没有任何启用的线路：transports 全部 enabled:false')

  const byKind = new Map(lines.map(line => [line.kind, line]))
  /** targetKey → transportKind（出站路由表） */
  const targetKinds = new Map()
  let lastInbound = null

  /** 从 store 的历史对话恢复路由：插件重载后还没收到新消息也能发对线路。 */
  if (store !== null && store !== undefined && typeof store.chatKeys === 'function') {
    for (const chatKey of store.chatKeys()) {
      try {
        const parsed = parseChatKey(chatKey)
        if (!byKind.has(parsed.transportKind)) continue
        const chat = typeof store.chat === 'function' ? store.chat(chatKey) : null
        const target = chat?.lastTarget ?? null
        if (target !== null && target !== undefined) targetKinds.set(targetKey(target), parsed.transportKind)
      } catch {
        /* 历史数据里的异常 chatKey 忽略，不影响启动 */
      }
    }
  }

  const remember = (target, kind) => {
    let key
    try {
      key = targetKey(target)
    } catch {
      return
    }
    targetKinds.set(key, kind)
    lastInbound = { target, kind }
  }

  /** target 属于哪条线路（没记录时返回 null）。 */
  const kindForTarget = target => {
    try {
      const kind = targetKinds.get(targetKey(target))
      return kind !== undefined && byKind.has(kind) ? kind : null
    } catch {
      return null
    }
  }

  /** target 对应的线路条目（未记录时回落到最近入站线路，再回落到第一条）。 */
  const entryForTarget = target => {
    const kind = kindForTarget(target)
    if (kind !== null) return byKind.get(kind)
    if (lastInbound !== null) return byKind.get(lastInbound.kind) ?? lines[0]
    return lines[0]
  }

  const activeEntry = () => (lastInbound !== null ? (byKind.get(lastInbound.kind) ?? lines[0]) : lines[0])

  /** 转发一个出站方法到 target 所属线路。 */
  const forward = method => (target, ...args) => {
    const entry = entryForTarget(target)
    const fn = entry.transport[method]
    if (typeof fn !== 'function') {
      return Promise.resolve({ ok: false, error: `线路 ${entry.kind} 不支持 ${method}` })
    }
    return fn.call(entry.transport, target, ...args)
  }

  /** 聚合状态：沿用单 transport 的字段名，多线细节放 lines。 */
  const status = () => {
    const lineStatuses = lines.map(line => ({ kind: line.kind, ...line.transport.status() }))
    const connected = lineStatuses.filter(line => line.connected === true)
    const first = lineStatuses[0]
    const errorLine = lineStatuses.find(line => String(line.lastError ?? '') !== '') ?? null
    const allConnected = connected.length === lineStatuses.length
    return {
      connected: connected.length > 0,
      phase: allConnected ? 'connected' : connected.length > 0 ? 'partial' : (first.phase ?? 'disconnected'),
      accountId: first.accountId ?? '',
      kind: lines.length === 1 ? first.kind : 'multi',
      lines: lineStatuses,
      connectedCount: connected.length,
      lineCount: lineStatuses.length,
      lastError: errorLine === null ? '' : `${errorLine.kind}: ${errorLine.lastError}`,
      tokenConfigured: lineStatuses.some(line => line.tokenConfigured === true),
      backend: lineStatuses.map(line => line.backend).filter(value => value !== undefined && value !== '').join(' / '),
      endpoint: lineStatuses.map(line => line.endpoint).filter(value => value !== undefined && value !== '').join(' / '),
    }
  }

  const start = async ({ signal } = {}) => {
    const results = await Promise.all(
      lines.map(line => line.transport.start({ signal }).catch(error => {
        log.warn(`dsh-qq: 线路 ${line.kind} 启动失败：${messageOf(error)}`)
        return false
      })),
    )
    return results.some(value => value === true)
  }
  const stop = async () => {
    await Promise.all(lines.map(line => line.transport.stop().catch(error => log.warn(`dsh-qq: 线路 ${line.kind} 停止失败：${messageOf(error)}`))))
  }
  const restart = async (kind = null) => {
    const targets = kind === null ? lines : [byKind.get(String(kind))].filter(Boolean)
    await Promise.all(targets.map(line => line.transport.stop().catch(() => {})))
    const results = await Promise.all(
      targets.map(line => line.transport.start({ signal: scope?.signal }).catch(() => false)),
    )
    return results.some(value => value === true)
  }

  return {
    kind: lines.length === 1 ? lines[0].kind : 'multi',
    /** 单线路部署时返回那条真实 transport（测试/诊断直连用）；多线路返回 null。 */
    single: () => (lines.length === 1 ? lines[0].transport : null),
    lines: () => lines.map(line => ({ kind: line.kind, ...line.transport.status() })),
    kinds: () => lines.map(line => line.kind),
    entries: lines,
    forKind: kind => byKind.get(String(kind)) ?? null,
    kindForTarget,
    forTarget: target => entryForTarget(target),
    remember,
    capabilities: () => activeEntry().transport.capabilities(),
    capabilitiesFor: target => entryForTarget(target).transport.capabilities(),
    status,
    start,
    stop,
    restart,
    onMessage: handler => {
      const disposers = lines.map(line =>
        line.transport.onMessage(ev => {
          remember(ev?.target, line.kind)
          return handler(ev)
        }),
      )
      return () => disposers.forEach(dispose => typeof dispose === 'function' && dispose())
    },
    onInteraction: handler => {
      const disposers = lines.map(line => {
        if (typeof line.transport.onInteraction !== 'function') return () => {}
        return line.transport.onInteraction(payload => handler({ ...payload, transportKind: line.kind }))
      })
      return () => disposers.forEach(dispose => typeof dispose === 'function' && dispose())
    },
    sendText: forward('sendText'),
    sendMedia: forward('sendMedia'),
    sendKeyboard: forward('sendKeyboard'),
    sendTyping: forward('sendTyping'),
    downloadMedia: (url, opts) => activeEntry().transport.downloadMedia(url, opts),
    downloadMediaFor: (target, url, opts) => {
      const entry = entryForTarget(target)
      return typeof entry.transport.downloadMedia === 'function' ? entry.transport.downloadMedia(url, opts) : Promise.resolve({ ok: false, error: '该线路不支持下载媒体' })
    },
    hasCredentials: () => lines.some(line => (typeof line.transport.hasCredentials === 'function' ? line.transport.hasCredentials() === true : false)),
    hasCredentialsFor: kind => {
      const entry = byKind.get(String(kind)) ?? null
      if (entry === null) return false
      return typeof entry.transport.hasCredentials === 'function' ? entry.transport.hasCredentials() === true : false
    },
    loginHintFor: kind => {
      const entry = byKind.get(String(kind)) ?? null
      if (entry === null || typeof entry.transport.loginHint !== 'function') return null
      return entry.transport.loginHint()
    },
  }
}
