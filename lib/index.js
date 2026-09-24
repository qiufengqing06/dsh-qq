/**
 * dsh-qq —— DSH 的 QQ 渠道插件（Cordis 组合包入口）。
 *
 * 装配顺序（执行文档 §5.4）：
 *   ResourceScope → config → store → transport → approval → bridge → router → control
 *   → 渠道注册表登记（de_channel_send channels=qq）→ 命令注册 → 审批 answerer → transport 启动
 *
 * 设计铁律（见项目关键记忆）：
 *   - 协议差异只存在于 transport 实现里；上层只问 capabilities()；
 *   - 入站只有一条链路：transport.onMessage → router.routeInbound；
 *   - 所有运行时资源挂 ResourceScope，插件卸载一次性释放。
 */

import { createResourceScope } from './scope.js'
import { resolveConfig, resolveCredentials } from './config.js'
import { createStore } from './store.js'
import { createApprovalRegistry } from './approval.js'
import { createBridge } from './bridge.js'
import { createRouter } from './router.js'
import { createControl } from './control.js'
import { createOnboardingProvider } from './onboarding.js'
import { createUnavailableTransport, fromChannelTarget, wantsMarkdown } from './transport.js'

export const name = 'dsh-qq'

/**
 * 静态注入：agents 是必备服务（桥接会话）。
 * commands/sessionPersistence 等按需动态获取（ctx.get），缺失时如实降级，
 * 不让插件因部署形态不同而整体加载失败。
 */
export const inject = ['agents']

/** transport 模块加载表（新增一个协议实现 = 新增一行 + 一个文件，上层不需要改）。 */
const TRANSPORT_LOADERS = Object.freeze({
  mock: () => import('./mock.js'),
  qqbot: () => import('./qqbot.js'),
})

const messageOf = error => (error instanceof Error ? error.message : String(error))

/** ctx → 插件内部句柄（测试与诊断用；cordis 不接受 apply 返回普通对象）。 */
const pluginHandles = new WeakMap()

/**
 * 读取某个 ctx 上的插件句柄（apply 完成后可用）。
 * @param {object} ctx
 * @returns {object|undefined}
 */
export function getPluginHandle(ctx) {
  return pluginHandles.get(ctx)
}

/**
 * 插件装配。
 * 注意：cordis 要求 apply 的返回值只能是 disposer 函数 / 空 / 可迭代——
 * 返回普通对象会报 `TypeError: Invalid effect`（真实 cordis 的 safeCollect 校验）。
 * 因此这里返回一个幂等 disposer，句柄经 getPluginHandle(ctx) 暴露。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - profile 行 config。
 * @returns {Promise<() => Promise<void>>} 释放资源的 disposer。
 */
export async function apply(ctx, rawConfig = {}) {
  if (ctx === null || typeof ctx !== 'object') throw new TypeError('dsh-qq: apply requires a Cordis context')
  const config = resolveConfig(rawConfig ?? {})
  const logger = ctx.logger ?? null
  const log = {
    info: message => {
      try {
        logger?.info?.(message)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(message)
      } catch {
        /* ignore */
      }
    },
  }

  const scope = createResourceScope({
    name: 'dsh-qq',
    onError: (error, label) => log.warn(`dsh-qq: ${label} 失败：${messageOf(error)}`),
  })

  const store = createStore({ dir: config.dataDir, logger })
  const loaded = await store.load()
  log.info(
    `dsh-qq: 状态目录 ${config.dataDir}（${loaded.recovered ? '损坏已重建' : loaded.fresh ? '首次创建' : '已加载'}），store=${store.file}`,
  )

  const approval = createApprovalRegistry({ ttlMs: config.approvalTtlMs })

  const transport = await loadTransport({ ctx, config, scope, log })

  const bridge = createBridge({
    ctx,
    config,
    store,
    transport,
    scope,
    logger,
    // 会话就绪后套用该 chat 持久化的模型/推理选择（P3）
    onAgentReady: (agent, chatKey) => control.applyStoredSelection(agent, chatKey),
  })
  const onboarding = createOnboardingProvider({ portalHost: config.portalHost, logger })
  const control = createControl({
    ctx,
    config,
    store,
    bridge,
    transport,
    approval,
    scope,
    logger,
    onboarding,
    onCredentialsChanged: info => log.info(`dsh-qq: 凭据已更新（AppID ${info.appId}${info.userOpenId === '' ? '' : `，扫码者 ${info.userOpenId}`}）`),
  })
  const router = createRouter({
    config,
    store,
    control,
    bridge,
    logger,
    dshCommand: createDshCommandRunner({ ctx, bridge, log }),
  })

  // 入站唯一入口：router 的回复（命令结果/配对提示/队列拒绝）需要回发 QQ
  const disposeInbound = transport.onMessage(ev => {
    void (async () => {
      try {
        const result = await router.routeInbound(ev)
        const reply = typeof result?.reply === 'string' ? result.reply.trim() : ''
        if (reply === '') return
        await transport.sendText(ev.target, result.reply, {
          ...(ev.messageId === '' ? {} : { replyTo: ev.messageId }),
          markdown: wantsMarkdown(config.markdown, transport.capabilities()),
        })
      } catch (error) {
        log.warn(`dsh-qq: 入站处理失败：${messageOf(error)}`)
      }
    })()
  })
  scope.add(disposeInbound, 'dsh-qq: inbound handler')

  // 交互回调（审批按钮）：走 control 的校验路径
  const disposeInteraction = transport.onInteraction(async payload => {
    try {
      const data = String(payload?.data ?? '')
      const parsed = approval.parseButtonData(data)
      if (parsed === null) return
      const decision = parsed.decision === 'allow' ? 'allow' : 'deny'
      const reply = await control.handleApprovalButton(data, payload, decision)
      if (reply !== null && payload?.target !== undefined) {
        await transport.sendText(payload.target, reply, {})
      }
    } catch (error) {
      log.warn(`dsh-qq: 交互回调处理失败：${messageOf(error)}`)
    }
  })
  scope.add(disposeInteraction, 'dsh-qq: interaction handler')

  // ① 渠道注册表登记：de_channel_send channels=qq / de_notify 即刻可用（实例隔离清理）
  const entry = createChannelEntry({ config, store, transport, bridge })
  globalThis.__dshChannelNotify ??= {}
  globalThis.__dshChannelNotify.qq = entry
  ctx.effect(
    () => () => {
      if (globalThis.__dshChannelNotify?.qq === entry) delete globalThis.__dshChannelNotify.qq
    },
    'dsh-qq: channel registry',
  )

  // ② 命令注册（Web 侧可发现；QQ 侧由 router 直接执行）
  ctx.inject(['commands'], commandsCtx => control.registerCommands(commandsCtx.commands))

  // ③ 审批 answerer（把 DSH 审批推到 QQ）
  ctx.effect(() => control.installApprovalAnswerer(), 'dsh-qq: approval answerer')

  // ④ 资源释放兜底
  ctx.effect(() => () => scope.dispose(), 'dsh-qq: resource scope')

  // ⑤ 连接（不阻塞插件加载；ready 供测试与诊断等待首次连接结果）
  const connectOnce = async () => {
    const started = await transport.start({ signal: scope.signal })
    const status = typeof transport.status === 'function' ? transport.status() : {}
    // 登录成功后把账号记为命名空间（chatKey 的 transport 维度）。
    // 必须「不同就更新」：不同协议记录的账号标识不同（官方协议是 AppID），切协议后旧值会误导诊断与出站目标。
    if (started && typeof status.accountId === 'string' && status.accountId !== '' && store.accountId() !== status.accountId) {
      await store.setAccountId(status.accountId)
    }
    // 失败原因写进状态文件（宿主 stdout 外部看不到，写盘才可诊断）
    if (started) await store.setMeta({ lastStartError: null })
    else await store.setMeta({ lastStartError: `${status.phase}: ${status.lastError || '未知原因'}`.slice(0, 500) })
    return started
  }
  const ready = config.autoConnect ? scope.run(connectOnce, 'dsh-qq: transport start') : Promise.resolve(false)

  // ⑥ 凭据在启动后才就绪或发生更新时自动连接（启动期服务未发布 / 用户后来写入凭据）
  if (config.autoConnect) {
    const credentialsHost = typeof ctx.root?.on === 'function' ? ctx.root : typeof ctx.on === 'function' ? ctx : null
    if (credentialsHost !== null) {
      scope.add(
        credentialsHost.on('credentials/reference-updated', ref => {
          const name = String(ref ?? '')
          if (name !== 'QQ_APP_ID' && name !== 'QQ_CLIENT_SECRET') return
          if (transport.status().connected === true) return
          log.info(`dsh-qq: 凭据 ${name} 已就绪/更新，尝试连接`)
          scope.run(connectOnce, 'dsh-qq: credentials reconnect')
        }),
        'dsh-qq: credentials listener',
      )
    }
  }

  // ⑦ 断线看门狗：以下三种情况会让插件停在未连接，且 transport 自己救不回来——
  //    1) 启动竞态：credentials 服务已发布、但它的文档还在异步加载，首次解析拿到空凭据
  //       （credentials-local 的 loadInitial 不派发 reference-updated，等不到事件）；
  //    2) 重连次数耗尽（phase=disconnected）或 fatal（权限/沙箱问题修好之后）；
  //    3) socket 静默死亡后没有任何重连定时器。
  //    真机现象：重启 DSH 后 qqbot 默认没启动，必须手动关开插件才连上。
  if (config.autoConnect) {
    /** no-credentials 相位是否已有可用的凭据/配置（用于决定要不要复活）。 */
    const credentialsReady = async () => {
      if (typeof transport.hasCredentials === 'function') return transport.hasCredentials() === true
      return (await resolveCredentials(ctx)) !== null
    }
    const revivable = new Set(['no-credentials', 'disconnected', 'fatal'])
    let watchdogBusy = false
    let loggedPhase = ''
    const watchdogTick = async () => {
      const status = typeof transport.status === 'function' ? transport.status() : { connected: false, phase: 'unknown' }
      if (status.connected === true) return
      if (!revivable.has(status.phase)) return
      // 凭据/配置真的没有时保持安静（等 credentials/reference-updated 或用户改配置），齐了才值得复活。
      // transport 可自带 hasCredentials()：由实现自己判断「配置是否齐备」，比插件层猜更准。
      if (status.phase === 'no-credentials' && !(await credentialsReady())) return
      if (loggedPhase !== status.phase) {
        loggedPhase = status.phase
        log.info(`dsh-qq: 看门狗发现未连接（${status.phase}），自动重启 transport`)
      }
      await transport.stop()
      await connectOnce()
    }
    scope.timer(
      () => {
        if (watchdogBusy) return
        watchdogBusy = true
        void scope.run(async () => {
          try {
            await watchdogTick()
          } finally {
            watchdogBusy = false
          }
        }, 'dsh-qq: watchdog')
      },
      config.watchdogIntervalMs,
      { repeat: true, label: 'dsh-qq: watchdog' },
    )
  }

  log.info(`dsh-qq: 已装配（transport=${config.transport}，autoConnect=${config.autoConnect}）`)

  pluginHandles.set(ctx, { config, store, transport, bridge, router, control, approval, scope, ready })
  return () => scope.dispose()
}

/** 按配置加载 transport 实现；模块缺失/加载失败时退化为「未实现」transport（插件仍可用命令与状态）。 */
async function loadTransport({ ctx, config, scope, log }) {
  const loader = TRANSPORT_LOADERS[config.transport]
  if (loader === undefined) {
    return createUnavailableTransport(config.transport, `未知 transport: ${config.transport}`)
  }
  // 测试注入口（可选服务）：让集成测试把 transport 指向假 QQ 服务，不影响生产路径。
  const deps = ctx.get?.('dshQqTransportDeps') ?? {}
  try {
    const module = await loader()
    const factory = module.createTransport ?? module.default
    if (typeof factory !== 'function') throw new TypeError(`transport 模块未导出 createTransport`)
    const transport = await factory({ config, ctx, scope, logger: ctx.logger ?? null, deps })
    log.info(`dsh-qq: transport ${config.transport} 已加载`)
    return transport
  } catch (error) {
    const reason = messageOf(error)
    log.warn(`dsh-qq: transport ${config.transport} 不可用（${reason}）——插件以降级模式运行`)
    return createUnavailableTransport(config.transport, reason)
  }
}

/** DSH 原生 / 命令执行钩子：仅有活跃会话时可用（QQ 命令由 control 处理，不会走到这里）。 */
function createDshCommandRunner({ ctx, bridge, log }) {
  return async (ev, line) => {
    const commands = ctx.get?.('commands')
    if (commands === undefined || commands === null || typeof commands.execute !== 'function') return null
    const sessionId = bridge.currentSession(ev.chatKey)
    if (!sessionId) return null
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined || agent === null) return null
    try {
      const execution = await commands.execute(agent, line, [])
      const result = execution?.result ?? execution
      if (result === null || result === undefined) return null
      if (result.kind === 'success') return { handled: true, reply: result.text ?? '已执行。' }
      return { handled: true, reply: result.text ?? '命令执行失败。' }
    } catch (error) {
      log.warn(`dsh-qq: DSH 命令执行失败：${messageOf(error)}`)
      return { handled: true, reply: `命令执行失败：${messageOf(error)}` }
    }
  }
}

/** 渠道注册表条目（供 de_channel_send / de_notify / COI 通知使用）。 */
function createChannelEntry({ config, store, transport, bridge }) {
  const accountOf = () => store.accountId() || config.accountId || 'unknown'
  const resolve = channelTarget => {
    const parsed = fromChannelTarget(channelTarget, config.transport, accountOf())
    return parsed === null ? null : parsed.target
  }
  const guard = fn => async (target, ...rest) => {
    const structured = resolve(target)
    if (structured === null) {
      return { ok: false, error: `无法解析发送目标 ${JSON.stringify(target)}（需要 {kind:'p2p'|'group', id}）` }
    }
    return fn(structured, ...rest)
  }
  return {
    send: guard((structured, text, opts) => transport.sendText(structured, text, opts ?? {})),
    /**
     * DSH 渠道直发（de_channel_send）约定：**纯文本也走 sendMedia 槽位**，
     * 载荷形如 `{kind:'text', content}`；只有附件才是真正的媒体。
     * 不认这个约定的话，`de_channel_send channels=qq` 发文本会直接报
     * 「sendMedia 需要 url / base64 / path 之一」——真机踩过。
     */
    sendMedia: guard((structured, media, opts) => {
      if (media !== null && typeof media === 'object' && media.kind === 'text') {
        const text = typeof media.content === 'string' ? media.content : typeof media.text === 'string' ? media.text : ''
        if (text.trim() === '') return Promise.resolve({ ok: false, error: '渠道直发文本为空（content）' })
        return transport.sendText(structured, text, opts ?? {})
      }
      return transport.sendMedia(structured, media, opts ?? {})
    }),
    sendKeyboard: guard((structured, text, buttons, opts) => transport.sendKeyboard(structured, text, buttons, opts ?? {})),
    recentChat: () => bridge.recentChat(),
    status: () => ({ ...transport.status(), kind: config.transport, store: store.stats() }),
  }
}

export default { name, inject, apply }
