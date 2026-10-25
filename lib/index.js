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
import { createBridge, toPlainText } from './bridge.js'
import { createRouter } from './router.js'
import { createControl } from './control.js'
import { createOnboardingProvider } from './onboarding.js'
import { createGroupMemory, createGroupNoteTool } from './group-memory.js'
import { createWebUi } from './web-ui.js'
import { createAlertManager } from './alerts.js'
import { fromChannelTarget, wantsMarkdown } from './transport.js'
import { createTransportRegistry } from './transports.js'

export const name = 'dsh-qq'

/**
 * 静态注入：agents 是必备服务（桥接会话）。
 * commands/sessionPersistence 等按需动态获取（ctx.get），缺失时如实降级，
 * 不让插件因部署形态不同而整体加载失败。
 */
export const inject = ['agents']

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

  const approval = createApprovalRegistry({
    ttlMs: config.approvalTtlMs,
    // 审批结果落一条审计记录（控制台「最近审批」）：谁、哪个会话、允许还是拒绝
    onDecision: record => {
      if (typeof store.recordApproval !== 'function') return
      void store.recordApproval({
        at: record.decidedAt,
        chatKey: record.chatKey,
        decision: record.decision,
        actorId: record.decidedBy,
        summary: record.summary,
        approvalId: record.approvalId,
      }).catch(() => {})
    },
  })

  /** Web 控制台句柄（在 control 之后创建；configPageUrl getter 需要它）。 */
  let webUi = null

  // 多线路注册表：transports 数组里的每条线路各起一个 transport（单线部署等价于旧行为）。
  // 出站按 target 路由到对应线路，入站由各线路各自回调（事件已带 chatKey/transportKind）。
  const transport = await createTransportRegistry({ ctx, config, scope, log, store })

  // 群记忆：环境缓冲（内存）+ 每群笔记（落盘）。注入只发生在「被 @ 走到 bridge」的那一轮，
  // 未 @ 的群消息只进缓冲，不进 LLM、不建会话——热闹群既不会丢上下文，也不会多花钱。
  const groupMemory = createGroupMemory({ dir: config.dataDir, config, logger })

  const bridge = createBridge({
    ctx,
    config,
    store,
    transport,
    scope,
    logger,
    // 会话就绪后套用该 chat 持久化的模型/推理选择（P3）
    onAgentReady: (agent, chatKey) => control.applyStoredSelection(agent, chatKey),
    // 回合失败时让 control 判断是否属于「模型不可用」并自愈（清失效选择 + 回退全局默认）
    onTurnError: (chatKey, failure) => control.recoverFromModelFailure(chatKey, failure),
    // 群上下文：长期记忆（笔记）+ 上次之后的群消息（含未 @ 的）
    ambientContext: async ev => {
      if (ev.target?.kind !== 'group') return null
      const notes = await groupMemory.notesOf(ev.chatKey, store.modeFor(ev.chatKey))
      const pending = groupMemory.pendingContext(ev.chatKey, store.modeFor(ev.chatKey))
      return { notes, recent: pending.text, omitted: pending.omitted }
    },
  })
  const onboarding = createOnboardingProvider({ portalHost: config.portalHost, logger })
  const control = createControl({
    ctx,
    config,
    store,
    configPageUrl: () => webUi?.url() ?? null,
    bridge,
    transport,
    approval,
    scope,
    logger,
    onboarding,
    onCredentialsChanged: info => log.info(`dsh-qq: 凭据已更新（AppID ${info.appId}${info.userOpenId === '' ? '' : `，扫码者 ${info.userOpenId}`}）`),
  })
  // Web 控制台：插件自带的自包含页面 + JSON API（零构建、零依赖）。
  // 写配置走官方 configEditor（校验 + 原子写 profile patch + 即时热重载）；
  // 动作（登录/登出/重连）与身份授权复用 control；webServer 缺失时静默降级。
  // 掉线提醒：页面告警条始终生效；QQ 通知优先用「另一条还活着的线路」私聊主人。
  const alerts = createAlertManager({
    config,
    store,
    transports: transport,
    pageUrl: () => webUi?.url() ?? null,
    logger,
  })

  webUi = createWebUi({ ctx, config, store, transport, control, alerts, groupMemory, logger })

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
    // 通道活动量：所有入站消息（含未 @ 的群消息）按线路、按天计数，供控制台画近 7 天趋势。
    // 计数失败不影响消息链路本身。
    try {
      void store.recordActivity?.(ev?.transportKind ?? null)?.catch?.(() => {})
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        const result = await router.routeInbound(ev)
        // 群记忆的环境缓冲放在**路由之后**：本条消息不该出现在自己这一轮的「群最近消息」里，
        // 但必须被记下来供下一轮使用（未 @ 机器人的群消息就是靠这里才有上下文的）。
        try {
          groupMemory.observe(ev, store.modeFor(ev.chatKey))
        } catch (error) {
          log.warn(`dsh-qq: 群记忆缓冲失败：${messageOf(error)}`)
        }
        const reply = typeof result?.reply === 'string' ? result.reply.trim() : ''
        if (reply !== '') {
          // DSH 原生命令（router 转交 ctx.commands.execute）的返回文本可能带 Markdown，
          // 在无渲染能力的渠道里同样要降级成纯文本（与 bridge 的回复同口径）。
          const route = { transportKind: ev.transportKind, accountId: ev.accountId }
          const markdown = wantsMarkdown(config.markdown, transport.capabilitiesFor?.(ev.target, route) ?? transport.capabilities())
          await transport.sendText(ev.target, markdown ? result.reply : toPlainText(result.reply) || result.reply, {
            ...(ev.messageId === '' ? {} : { replyTo: ev.messageId }),
            markdown,
            ...route,
          })
        }
        // 配对批准后的「补答」：命令返回一个归一化事件，仍然走 router 投递（保持入站唯一入口），
        // 否则陌生人被批准后必须把首条消息再发一遍才有回应（真机反馈 2026-09-24）。
        const replay = result?.replay ?? null
        if (replay === null || typeof replay !== 'object') return
        const replayed = await router.routeInbound(replay)
        const replayReply = typeof replayed?.reply === 'string' ? replayed.reply.trim() : ''
        if (replayReply === '') return
        const replayRoute = { transportKind: replay.transportKind, accountId: replay.accountId }
        await transport.sendText(replay.target, replayed.reply, {
          markdown: wantsMarkdown(config.markdown, transport.capabilitiesFor?.(replay.target, replayRoute) ?? transport.capabilities()),
          ...replayRoute,
        })
      } catch (error) {
        log.warn(`dsh-qq: 入站处理失败：${messageOf(error)}`)
      }
    })()
  })
  // 卸载/重载前把微批窗口里的状态刷盘（否则最近一条 activity/usage 可能丢）
  if (typeof store.flushSave === 'function') {
    scope.add(() => store.flushSave(), 'dsh-qq: store flush')
  }
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
        await transport.sendText(payload.target, reply, {
          ...(typeof payload.transportKind === 'string' ? { transportKind: payload.transportKind } : {}),
          ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
        })
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

  // ②.5 群记忆工具（qq_group_note）：让模型自己维护当前群的长期记忆。
  //      与 DSH 记忆工具同一种模式（模型在自己的回合里写），零额外 LLM 调用；
  //      tools 服务缺失时静默跳过——群记忆不写入但读取/注入仍可用。
  if (config.groupMemory?.enabled === true) {
    const groupNoteTool = createGroupNoteTool({
      memory: groupMemory,
      chatKeyOf: sessionId => {
        const chatKey = bridge.chatKeyForSession(sessionId)
        if (chatKey === null) return null
        const last = store.chat(chatKey).lastTarget
        return last !== null && last !== undefined && last.kind === 'group' ? chatKey : null
      },
      modeOf: chatKey => store.modeFor(chatKey),
    })
    ctx.inject(['tools'], toolsCtx => {
      const tools = toolsCtx?.tools
      if (tools === undefined || tools === null || typeof tools.register !== 'function') {
        // 与 commands 同款降级：工具注册不了不影响群记忆的读取与注入，只少了"让模型自己写"的入口
        log.warn('dsh-qq: tools 服务不可用，qq_group_note 未注册（群记忆注入不受影响）')
        return () => {}
      }
      return tools.register(groupNoteTool)
    })
  }

  // ③ 审批 answerer（把 DSH 审批推到 QQ）
  ctx.effect(() => control.installApprovalAnswerer(), 'dsh-qq: approval answerer')

  // ③.5 Web 配置页（/dsh-qq）：webServer 存在时才注册路由
  webUi.register()

  // ④ 资源释放兜底
  ctx.effect(() => () => scope.dispose(), 'dsh-qq: resource scope')

  // ⑤ 连接（不阻塞插件加载；ready 供测试与诊断等待首次连接结果）
  /**
   * 启动线路并刷新诊断（kind=null 表示全部）。
   * 多线路时 `store.accountId` 只记第一条线路的账号（历史字段，仅展示用；
   * 每条对话的命名空间在 chatKey 里，不依赖它）。
   */
  const connectOnce = async (kind = null) => {
    const targets = kind === null ? transport.entries : [transport.forKind(kind)].filter(Boolean)
    const results = await Promise.all(
      targets.map(async entry => {
        try {
          return { kind: entry.kind, started: (await entry.transport.start({ signal: scope.signal })) === true }
        } catch (error) {
          log.warn(`dsh-qq: 线路 ${entry.kind} 启动失败：${messageOf(error)}`)
          return { kind: entry.kind, started: false }
        }
      }),
    )
    const lines = transport.lines()
    const first = lines[0] ?? null
    if (first !== null && first.connected === true && typeof first.accountId === 'string' && first.accountId !== '' && store.accountId() !== first.accountId) {
      await store.setAccountId(first.accountId)
    }
    // 失败原因写进状态文件（宿主 stdout 外部看不到，写盘才可诊断）。
    // 判定口径：本次启动过的线路看 started 结果（start 成功时相位可能还在 connecting），
    // 没参与的线路看它当前的连接状态。
    const startedKinds = new Map(results.map(result => [result.kind, result.started]))
    const problems = lines
      .filter(line => {
        if (startedKinds.has(line.kind)) return startedKinds.get(line.kind) !== true
        return line.connected !== true
      })
      .map(line => `${line.kind}: ${line.phase}${line.lastError === undefined || line.lastError === '' ? '' : `: ${line.lastError}`}`)
    await store.setMeta({ lastStartError: problems.length === 0 ? null : problems.join(' | ').slice(0, 500) })
    return results.some(result => result.started)
  }
  const ready = config.autoConnect ? scope.run(() => connectOnce(), 'dsh-qq: transport start') : Promise.resolve(false)

  // ⑥ 凭据在启动后才就绪或发生更新时自动连接（启动期服务未发布 / 用户后来写入凭据）
  if (config.autoConnect) {
    const credentialsHost = typeof ctx.root?.on === 'function' ? ctx.root : typeof ctx.on === 'function' ? ctx : null
    if (credentialsHost !== null) {
      scope.add(
        credentialsHost.on('credentials/reference-updated', ref => {
          const name = String(ref ?? '')
          const kinds = name === 'QQ_APP_ID' || name === 'QQ_CLIENT_SECRET' ? ['qqbot'] : []
          if (kinds.length === 0) return
          const target = kinds.find(kind => {
            const entry = transport.forKind(kind)
            return entry !== null && entry.transport.status().connected !== true
          })
          if (target === undefined) return
          log.info(`dsh-qq: 凭据 ${name} 已就绪/更新，尝试连接线路 ${target}`)
          scope.run(() => connectOnce(target), 'dsh-qq: credentials reconnect')
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
    /** 某条线路是否已有可用的凭据/配置（用于决定要不要复活）。 */
    const credentialsReadyFor = async kind => {
      const entry = transport.forKind(kind)
      if (entry === null) return false
      // transport 可自带 hasCredentials()（凭据来源由实现自己决定）
      if (typeof entry.transport.hasCredentials === 'function') return entry.transport.hasCredentials() === true
      return (await resolveCredentials(ctx)) !== null
    }
    const revivable = new Set(['no-credentials', 'disconnected', 'fatal'])
    let watchdogBusy = false
    const loggedPhase = new Map()
    const watchdogTick = async () => {
      const lines = transport.lines()
      const connected = lines.filter(line => line.connected === true)
      if (connected.length === lines.length) {
        // 自愈后清掉陈旧诊断：transport 内部的退避重连**不经过 connectOnce**，所以 store 里的
        // lastStartError 会一直留着（真机 2026-09-28：WS 连接数已是 1，meta 里却还写着
        // 「握手超时」——而排查手册第一条就是看这个字段，直接被误导）。连着就说明没事。
        const meta = store.snapshot().meta
        if (meta.lastStartError !== null && meta.lastStartError !== undefined) {
          await store.setMeta({ lastStartError: null })
        }
        return
      }
      for (const line of lines) {
        if (line.connected === true) continue
        if (!revivable.has(line.phase)) continue
        // 凭据/配置真的没有时保持安静（等 credentials/reference-updated 或用户改配置），齐了才值得复活。
        if (line.phase === 'no-credentials' && !(await credentialsReadyFor(line.kind))) continue
        if (loggedPhase.get(line.kind) !== line.phase) {
          loggedPhase.set(line.kind, line.phase)
          log.info(`dsh-qq: 看门狗发现线路 ${line.kind} 未连接（${line.phase}），自动重启该线路`)
        }
        const entry = transport.forKind(line.kind)
        if (entry === null) continue
        await entry.transport.stop().catch(() => {})
        await connectOnce(line.kind)
      }
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

  // ⑥ 掉线提醒：每 10 秒评估一次线路状态（页面告警条 + 可选 QQ 通知）。
  //   首轮立即跑一次，让控制台在插件刚起来时就能看到初始状态。
  if (config.alerts?.enabled !== false) {
    void scope.run(() => alerts.evaluate(), 'dsh-qq: alerts first pass')
    scope.timer(
      () => {
        void scope.run(() => alerts.evaluate(), 'dsh-qq: alerts')
      },
      10_000,
      { repeat: true, label: 'dsh-qq: alerts' },
    )
  }

  log.info(`dsh-qq: 已装配（transport=${config.transport}，autoConnect=${config.autoConnect}）`)

  pluginHandles.set(ctx, {
    config,
    store,
    // 单线路部署时给真实 transport（旧测试/诊断直接调 dump()/injectText() 等具体实现）；多线路给注册表
    transport: typeof transport.single === 'function' && transport.single() !== null ? transport.single() : transport,
    transports: transport,
    bridge,
    router,
    control,
    approval,
    alerts,
    scope,
    ready,
  })
  return () => scope.dispose()
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
    // 渠道 target 可能带插件扩展的 transportKind/accountId（recentChat 返回的会带）：
    // 多线路同 ID 时必须用它，否则只能回落到 configure 的单线路默认值。
    const kind = typeof channelTarget?.transportKind === 'string' && channelTarget.transportKind !== '' ? channelTarget.transportKind : config.transport
    const account = typeof channelTarget?.accountId === 'string' && channelTarget.accountId !== '' ? channelTarget.accountId : accountOf()
    return fromChannelTarget(channelTarget, kind, account)
  }
  const guard = fn => async (target, ...rest) => {
    const parsed = resolve(target)
    if (parsed === null) {
      return { ok: false, error: `无法解析发送目标 ${JSON.stringify(target)}（需要 {kind:'p2p'|'group', id}）` }
    }
    const route = { transportKind: parsed.transportKind, accountId: parsed.accountId }
    return fn(parsed.target, route, ...rest)
  }
  return {
    send: guard((structured, route, text, opts) => transport.sendText(structured, text, { ...(opts ?? {}), ...route })),
    /**
     * DSH 渠道直发（de_channel_send）约定：**纯文本也走 sendMedia 槽位**，
     * 载荷形如 `{kind:'text', content}`；只有附件才是真正的媒体。
     * 不认这个约定的话，`de_channel_send channels=qq` 发文本会直接报
     * 「sendMedia 需要 url / base64 / path 之一」——真机踩过。
     */
    sendMedia: guard((structured, route, media, opts) => {
      if (media !== null && typeof media === 'object' && media.kind === 'text') {
        const text = typeof media.content === 'string' ? media.content : typeof media.text === 'string' ? media.text : ''
        if (text.trim() === '') return Promise.resolve({ ok: false, error: '渠道直发文本为空（content）' })
        return transport.sendText(structured, text, { ...(opts ?? {}), ...route })
      }
      return transport.sendMedia(structured, media, { ...(opts ?? {}), ...route })
    }),
    sendKeyboard: guard((structured, route, text, buttons, opts) => transport.sendKeyboard(structured, text, buttons, { ...(opts ?? {}), ...route })),
    recentChat: () => bridge.recentChat(),
    status: () => ({ ...transport.status(), kind: config.transport, store: store.stats() }),
  }
}

export default { name, inject, apply }
