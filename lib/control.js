/**
 * 远程控制命令与审批转发（执行文档 F6、§5.5、§5.7）。
 *
 * - 命令由 router 拦截后进入本模块，永不进入 LLM context（铁律 #2）。
 * - 权限：每个命令声明所属动作域（sessionControl / modelControl / chat），
 *   由 config.controlPolicy 决定最低角色（评审 §8：与聊天授权分离）。
 * - 审批转发：注册 `approval/request` answerer，把 DSH 的 exec 审批推到 QQ
 *   （文本 + InlineKeyboard 按钮），校验 nonce/过期/会话/用户后返回 ApprovalOutcome。
 *
 * P0 已实现：命令框架 + help/status/sessions/switch/new/stop + 审批转发。
 * 其余命令按执行文档阶段计划返回「将在 P3/P4 启用」的如实回复。
 */

import { clearCredentials, resolveCredentials, roleAllows, saveCredentials } from './config.js'
import { parseCommand } from './router.js'

/** 命令表：name → 元数据与处理器。 */
export const COMMAND_SPECS = Object.freeze([
  { name: '/qq-help', action: 'chat', usage: '/qq-help', description: '显示本帮助' },
  { name: '/qq-status', action: 'chat', usage: '/qq-status', description: '连接/账号/会话/权限状态' },
  { name: '/qq-sessions', action: 'sessionControl', usage: '/qq-sessions', description: '列出本对话的最近会话' },
  { name: '/qq-switch', action: 'sessionControl', usage: '/qq-switch <序号>', description: '切换到指定序号的会话' },
  { name: '/qq-new', action: 'sessionControl', usage: '/qq-new', description: '为本对话新建会话' },
  { name: '/qq-stop', action: 'sessionControl', usage: '/qq-stop [--keep]', description: '停止当前回合（默认清空排队）' },
  { name: '/qq-title', action: 'sessionControl', usage: '/qq-title <标题>', description: '重命名当前会话' },
  { name: '/qq-model', action: 'modelControl', usage: '/qq-model [list|provider/model] [--default]', description: '切换本会话模型' },
  { name: '/qq-reasoning', action: 'modelControl', usage: '/qq-reasoning [low|medium|high|default]', description: '调整本会话推理强度' },
  { name: '/qq-login', action: 'admin', usage: '/qq-login [--force]', description: '扫码登录（QQ 号扫码自动配置）' },
  { name: '/qq-logout', action: 'admin', usage: '/qq-logout', description: '清除凭据并断开连接' },
  { name: '/qq-reconnect', action: 'admin', usage: '/qq-reconnect', description: '重新连接 QQ 网关' },
  { name: '/qq-approve', action: 'admin', usage: '/qq-approve <openid>', description: '批准配对申请' },
  { name: '/qq-requests', action: 'admin', usage: '/qq-requests', description: '列出加好友/加群请求（个人 QQ 协议）' },
  { name: '/qq-request', action: 'admin', usage: '/qq-request <编号> allow|deny', description: '处理加好友/加群请求' },
])

const PENDING_PHASE = Object.freeze({})

/** 不依赖 QQ 会话上下文、可在 DSH 会话里直接执行的命令。 */
const WEB_EXECUTABLE = new Set(['/qq-help', '/qq-status', '/qq-login', '/qq-logout', '/qq-reconnect'])

/** Web 侧执行时的合成事件：没有 QQ 聊天上下文（通知自动跳过）。 */
const WEB_EVENT = Object.freeze({ chatKey: '', sender: Object.freeze({ id: 'web', name: 'web' }), target: null })

/** 推理强度：'default' 表示清空（回到 provider 默认）。 */
export const REASONING_CHOICES = Object.freeze(['low', 'medium', 'high'])

/** 动作域 → controlPolicy 键。'admin' 归入 approvals（owner/admin 级）。 */
function policyKeyOf(action) {
  return action === 'admin' ? 'approvals' : action
}

/**
 * 创建 control 模块。
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.config
 * @param {object} deps.store
 * @param {object} deps.bridge
 * @param {object} deps.transport
 * @param {object} deps.approval - approval.js 注册表。
 * @param {object} [deps.scope] - ResourceScope。
 * @param {object} [deps.logger]
 * @returns {object} control
 */
export function createControl({
  ctx,
  config,
  store,
  bridge,
  transport,
  approval,
  scope = null,
  logger = null,
  onboarding = null,
  onCredentialsChanged = null,
}) {
  const specs = new Map(COMMAND_SPECS.map(spec => [spec.name, spec]))
  /** approvalId → resolve（等待用户决策） */
  const waiters = new Map()

  const log = {
    warn: message => {
      try {
        logger?.warn?.(message)
      } catch {
        /* ignore */
      }
    },
  }

  const capabilities = () => {
    try {
      return transport.capabilities()
    } catch {
      return { markdown: false, keyboard: false, typing: false, media: [] }
    }
  }

  const deps = { config, store, bridge, transport, approval, logger }

  // ── P3：会话级模型/推理选择（本地实现 installModelSelection 的等价物：
  //    插件不能 import @deepseek-ai/dsh-agent，改用 agent.ctx 的事件 + 会话事件） ──
  /** sessionId → 已安装的选择 {provider, model, reasoningEffort, dispose} */
  const selections = new Map()

  /** 取当前 chat 的活跃 Agent（无会话时返回可读错误）。 */
  function requireAgent(ev) {
    const sessionId = bridge.currentSession(ev.chatKey)
    const agent = sessionId === '' || sessionId === undefined ? null : ctx.agents?.get?.(sessionId) ?? null
    if (agent === null || agent === undefined) {
      return { error: '本对话还没有活跃会话——先发一条普通消息即可创建，然后再用该命令。' }
    }
    return { agent, sessionId, chatKey: ev.chatKey }
  }

  /** 当前会话生效的选择：内存安装值 → 会话请求头 → store 持久化值。 */
  function currentSelectionOf(agent, chatKey) {
    const sessionId = agent?.session?.id ?? ''
    const installed = selections.get(sessionId)
    if (installed !== undefined) {
      return { provider: installed.provider, model: installed.model, reasoningEffort: installed.reasoningEffort }
    }
    try {
      const header = agent?.session?.requestHeader?.()
      const logged = header?.config
      if (typeof logged?.provider === 'string' && logged.provider !== '') {
        return {
          provider: logged.provider,
          model: String(logged.model ?? ''),
          ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: String(logged.reasoningEffort) }),
        }
      }
    } catch {
      /* 请求头不可读时退回 store */
    }
    const chat = store.chat(chatKey)
    if (typeof chat.model === 'string' && chat.model.includes('/')) {
      const [provider, ...rest] = chat.model.split('/')
      return {
        provider,
        model: rest.join('/'),
        ...(chat.reasoning === null || chat.reasoning === undefined ? {} : { reasoningEffort: chat.reasoning }),
      }
    }
    return null
  }

  /** 部署可用的 provider 路由（尽力而为）。 */
  function listProviders() {
    const llm = ctx.get?.('llm')
    if (llm === null || llm === undefined || typeof llm.listConfigurableProviders !== 'function') return []
    try {
      return llm.listConfigurableProviders().map(entry => ({
        provider: String(entry.provider ?? ''),
        ...(entry.displayName === undefined ? {} : { displayName: String(entry.displayName) }),
      }))
    } catch {
      return []
    }
  }

  /** 校验并规范化选择（有 llm 服务时走真实路由校验）。 */
  async function resolveSelection({ provider, model, reasoningEffort }) {
    const llm = ctx.get?.('llm')
    if (llm !== null && llm !== undefined && typeof llm.resolveCallConfig === 'function') {
      try {
        const resolved = await llm.resolveCallConfig({
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
        return {
          selection: {
            provider: String(resolved?.provider ?? provider),
            model: String(resolved?.model ?? model),
            ...(resolved?.reasoningEffort === undefined
              ? reasoningEffort === undefined
                ? {}
                : { reasoningEffort }
              : { reasoningEffort: String(resolved.reasoningEffort) }),
          },
        }
      } catch (error) {
        return { error: `模型不可用：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    return { selection: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
  }

  /**
   * 安装会话级选择（对齐 dsh-agent 的 installModelSelection 语义）：
   * ① 请求改写：下一请求生效、不撕裂进行中的请求；
   * ② 提示词变量：provider/model 同步给 prompt 组装；
   * ③ 会话事件 model/selection：写入持久日志（重启后可从 store 重新套用）。
   * @returns {{provider: string, model: string, reasoningEffort?: string, dispose: Function}|null}
   */
  function installSelection(agent, selection) {
    const sessionId = agent?.session?.id ?? ''
    if (sessionId === '') return null
    const previous = selections.get(sessionId)
    if (previous !== undefined) {
      try {
        previous.dispose()
      } catch {
        /* ignore */
      }
    }
    const { provider, model } = selection
    const reasoningEffort = selection.reasoningEffort
    const disposers = []
    const on = typeof agent.ctx?.on === 'function' ? agent.ctx.on.bind(agent.ctx) : null
    if (on !== null) {
      try {
        disposers.push(
          on('agent/request', async (_payload, next) => {
            const resolved = await next()
            const { reasoningEffort: _inherited, ...rest } = resolved ?? {}
            return {
              ...rest,
              provider,
              model,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            }
          }),
        )
        disposers.push(
          on('system-prompt/assemble', async (_assembly, _context, next) => {
            const assembled = await next()
            if (assembled === null || typeof assembled !== 'object') return assembled
            return { ...assembled, variables: { ...assembled.variables, provider, model } }
          }),
        )
      } catch (error) {
        log.warn(`dsh-qq: 安装模型选择监听失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      agent.session?.append?.('model/selection', {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
    } catch (error) {
      log.warn(`dsh-qq: 写入 model/selection 事件失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const entry = {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      dispose: () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
            else if (typeof dispose?.dispose === 'function') dispose.dispose()
          } catch {
            /* ignore */
          }
        }
      },
    }
    selections.set(sessionId, entry)
    return entry
  }

  /** 该 chat 持久化的选择（无则 null）。 */
  function storedSelection(chatKey) {
    const chat = store.chat(chatKey)
    if (typeof chat.model !== 'string' || !chat.model.includes('/')) return null
    const [provider, ...rest] = chat.model.split('/')
    return {
      provider,
      model: rest.join('/'),
      ...(chat.reasoning === null || chat.reasoning === undefined ? {} : { reasoningEffort: chat.reasoning }),
    }
  }

  /** DSH 默认模型（agentDefaultModel 服务；不可用时 null）。 */
  function defaultSelection() {
    const defaultModel = ctx.get?.('agentDefaultModel')
    const current = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : null
    if (current === null || current === undefined) return null
    if (typeof current.provider !== 'string' || current.provider === '') return null
    if (typeof current.model !== 'string' || current.model === '') return null
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
    }
  }

  /**
   * 会话就绪时**必须**安装模型选择（优先级：本 chat 持久化选择 → DSH 默认模型）。
   *
   * 为什么必须：persona 等提示词模板引用 `{{provider}}` / `{{model}}`，而这两个变量由
   * 模型选择安装器提供（Web 会话由 session-controller 装）。QQ 会话若没人装，
   * 提示词组装会直接抛 `prompt variable "{{model}}" has no value`，整轮失败。
   */
  function ensureSelection(agent, chatKey) {
    const stored = storedSelection(chatKey)
    const selection = stored ?? defaultSelection()
    if (selection === null) {
      log.warn('dsh-qq: 既无会话选择也无 DSH 默认模型，QQ 会话可能无法组装提示词')
      return null
    }
    const installed = installSelection(agent, selection)
    if (stored === null) {
      // 一并记住推理强度，避免下次恢复时丢失
      void store.setSelection(chatKey, {
        model: `${selection.provider}/${selection.model}`,
        reasoning: selection.reasoningEffort ?? null,
      })
    }
    return installed
  }

  /** 兼容旧名（bridge 的 onAgentReady 钩子调用）。 */
  const applyStoredSelection = ensureSelection

  const handlers = {
    '/qq-help': () => {
      const lines = ['dsh-qq 命令：']
      for (const spec of COMMAND_SPECS) {
        const phase = PENDING_PHASE[spec.name]
        lines.push(`  ${spec.usage} — ${spec.description}${phase === undefined ? '' : ` ［${phase} 启用］`}`)
      }
      lines.push('', `当前权限策略：${formatPolicy(config.controlPolicy)}`)
      return lines.join('\n')
    },

    '/qq-status': () => {
      const status = typeof transport.status === 'function' ? transport.status() : {}
      const stats = store.stats()
      const lines = [
        'dsh-qq 状态：',
        `  传输：${config.transport}（${status.connected === true ? '已连接' : '未连接'}${status.phase === undefined ? '' : ` / ${status.phase}`}）`,
        `  账号：${status.accountId || store.accountId() || '未配置'}`,
        `  待处理审批：${approval.pending({}).length}`,
      ]
      if (typeof status.endpoint === 'string' && status.endpoint !== '') {
        lines.push(`  端点：${status.endpoint}`)
      }
      // 后端画像与连接诊断（审查建议 §19）：token 只显示「是否已配置」，绝不显示值
      if (typeof status.backend === 'string' && status.backend !== '') {
        const features = status.features ?? {}
        const on = key => (features[key] === true ? 'yes' : 'no')
        lines.push(
          `  后端：${status.backend}${status.backendVersion === undefined || status.backendVersion === '' ? '' : ` ${status.backendVersion}`}`
          + `（typing=${on('inputStatus')}，取文件=${on('getFile')}，私聊文件=${on('uploadPrivateFile')}）`,
        )
        lines.push(`  token：${status.tokenConfigured === true ? '已配置' : '未配置'}；在途调用：${status.pendingCalls ?? 0}；连接代次：${status.generation ?? 0}`)
        if (Number.isFinite(status.lastFrameAgoMs)) {
          lines.push(`  最近收帧：${Math.round(status.lastFrameAgoMs / 1000)} 秒前（心跳 ${status.lastHeartbeatAgoMs === null || status.lastHeartbeatAgoMs === undefined ? '未知' : `${Math.round(status.lastHeartbeatAgoMs / 1000)} 秒前`}）`)
        }
      }
      if (Number.isSafeInteger(status.pendingRequests) && status.pendingRequests > 0) {
        lines.push(`  待处理请求：${status.pendingRequests} 条（/qq-requests 查看）`)
      }
      const account = store.accountId() || status.accountId || ''
      if (account === '') {
        const hint = typeof transport.loginHint === 'function' ? transport.loginHint() : ''
        lines.push(
          hint === ''
            ? '  提示：用 /qq-login 扫码登录，或通过 settings/credentials 配置入口写入 AppID/AppSecret'
            : `  提示：${hint}`,
        )
      }
      const bridgeStatus = bridge.status()
      lines.push(`  会话：${stats.chats} 个对话 / ${stats.sessions} 个最近会话（在途消息 ${bridgeStatus.pending}）`)
      lines.push(`  白名单：${stats.authorized} 人；配对策略：${config.pairingPolicy}`)
      return lines.join('\n')
    },

    '/qq-requests': () => {
      if (typeof transport.requests !== 'function') return '当前传输没有待处理请求（加好友/加群请求只在个人 QQ 协议下出现）。'
      const list = transport.requests()
      if (list.length === 0) return '没有待处理的加好友/加群请求。'
      const lines = ['待处理请求（用 /qq-request <编号> allow|deny 处理）：']
      list.forEach((entry, index) => {
        const who = entry.userId || '未知'
        const group = entry.groupId === '' || entry.groupId === undefined ? '' : ` 群 ${entry.groupId}`
        const comment = entry.comment === '' ? '' : `（${entry.comment}）`
        lines.push(`  [${index}] ${entry.type === 'group' ? '加群' : '加好友'} ${who}${group}${comment}`)
      })
      return lines.join('\n')
    },

    '/qq-request': async ({ cmd, ev }) => {
      if (typeof transport.requests !== 'function' || typeof transport.resolveRequest !== 'function') {
        return '当前传输不支持处理加好友/加群请求。'
      }
      const index = Number.parseInt(cmd.positional[0] ?? '', 10)
      const decision = String(cmd.positional[1] ?? '').toLowerCase()
      const list = transport.requests()
      if (!Number.isSafeInteger(index) || index < 0 || index >= list.length) {
        return '用法：/qq-request <编号> allow|deny（编号见 /qq-requests）'
      }
      if (decision !== 'allow' && decision !== 'deny') return '用法：/qq-request <编号> allow|deny'
      const target = list[index]
      const result = await transport.resolveRequest(target.flag, decision === 'allow')
      if (result.ok !== true) return `处理失败：${result.error ?? '未知原因'}`
      // 批准加好友后顺手给对方回一句，别让人干等
      if (decision === 'allow' && target.type === 'friend' && target.userId !== '') {
        try {
          await transport.sendText({ kind: 'dm', userId: target.userId }, '已通过好友请求，直接发消息就能用。')
        } catch {
          /* 回执失败不影响批准结果 */
        }
      }
      return `已${decision === 'allow' ? '同意' : '拒绝'} ${target.type === 'group' ? '加群' : '加好友'}请求（${target.userId}）。`
    },

    '/qq-sessions': ({ ev }) => {
      const sessions = bridge.sessions(ev.chatKey)
      if (sessions.length === 0) return '本对话还没有历史会话。'
      const current = bridge.currentSession(ev.chatKey)
      const lines = ['本对话的最近会话（↑ 越新）：']
      sessions.forEach((entry, index) => {
        const marker = entry.sessionId === current ? ' ← 当前' : ''
        const title = entry.title === '' ? '' : ` ${entry.title}`
        lines.push(`  [${index}] ${entry.sessionId}${title}${marker}`)
      })
      lines.push('', '用 /qq-switch <序号> 切换。')
      return lines.join('\n')
    },

    '/qq-switch': async ({ cmd, ev }) => {
      const raw = cmd.positional[0]
      const index = Number.parseInt(raw ?? '', 10)
      if (!Number.isSafeInteger(index)) return '用法：/qq-switch <序号>（序号见 /qq-sessions）'
      const entry = await bridge.switchSession(ev.chatKey, index)
      if (entry === null) return `没有序号为 ${raw} 的会话。`
      return `已切换到会话 ${entry.sessionId}${entry.title ? `（${entry.title}）` : ''}。`
    },

    '/qq-new': async ({ ev }) => {
      const sessionId = await bridge.newSession(ev.chatKey)
      if (sessionId === null) return '新建会话失败，请查看日志。'
      return `已为本对话新建会话 ${sessionId}。旧会话仍可用 /qq-sessions 找回。`
    },

    '/qq-stop': async ({ cmd, ev }) => {
      const keep = cmd.flags.has('--keep')
      const stopped = await bridge.stop(ev.chatKey, { keepQueue: keep })
      if (!stopped) return '当前没有正在执行的回合。'
      return keep ? '已停止当前回合（排队消息保留）。' : '已停止当前回合，并清空排队消息。'
    },

    '/qq-model': async ({ cmd, ev }) => {
      const wanted = cmd.positional[0]
      const holders = requireAgent(ev)
      if (holders.error !== undefined) return holders.error
      const { agent, chatKey } = holders

      if (wanted === undefined || wanted === 'list') {
        const current = currentSelectionOf(agent, chatKey)
        const providers = listProviders()
        const lines = [
          current === null
            ? '当前会话未固定模型（使用 DSH 默认）。'
            : `当前会话模型：${current.provider}/${current.model}${current.reasoningEffort === undefined ? '' : `（推理强度 ${current.reasoningEffort}）`}`,
        ]
        if (providers.length > 0) {
          lines.push('', '已配置的 provider 路由：')
          for (const entry of providers) lines.push(`  ${entry.provider}${entry.displayName === undefined ? '' : ` — ${entry.displayName}`}`)
        } else {
          lines.push('', '（当前部署未暴露 provider 目录，请直接给出 provider/model）')
        }
        lines.push('', '用法：/qq-model <provider>/<model>　仅本会话生效；加 --default 同时设为全局默认。')
        return lines.join('\n')
      }

      const slash = wanted.indexOf('/')
      if (slash <= 0 || slash === wanted.length - 1) {
        return '用法：/qq-model <provider>/<model>（例如 /qq-model deepseek/deepseek-chat）'
      }
      const provider = wanted.slice(0, slash)
      const model = wanted.slice(slash + 1)
      const previous = currentSelectionOf(agent, chatKey)
      const reasoningEffort = previous?.reasoningEffort
      const resolved = await resolveSelection({ provider, model, reasoningEffort })
      if (resolved.error !== undefined) return resolved.error

      const installed = installSelection(agent, resolved.selection)
      if (installed === null) return '当前会话尚未就绪，无法切换模型。'
      await store.setSelection(chatKey, { model: `${resolved.selection.provider}/${resolved.selection.model}` })

      let extra = ''
      if (cmd.flags.has('--default')) {
        const defaultModel = ctx.get?.('agentDefaultModel')
        if (defaultModel !== null && defaultModel !== undefined && typeof defaultModel.saveSelection === 'function') {
          try {
            await defaultModel.saveSelection(resolved.selection)
            extra = '，并已设为全局默认'
          } catch (error) {
            extra = `（全局默认保存失败：${error instanceof Error ? error.message : String(error)}）`
          }
        } else {
          extra = '（当前部署无 agentDefaultModel 服务，未改全局默认）'
        }
      }
      return `已切换本会话模型为 ${resolved.selection.provider}/${resolved.selection.model}${extra}。下一轮生效。`
    },

    '/qq-reasoning': async ({ cmd, ev }) => {
      const wanted = (cmd.positional[0] ?? '').toLowerCase()
      if (wanted === '') {
        const current = currentSelectionOf(requireAgent(ev).agent, ev.chatKey)
        return `当前推理强度：${current?.reasoningEffort ?? '默认'}。用法：/qq-reasoning low|medium|high|default`
      }
      if (wanted !== 'default' && !REASONING_CHOICES.includes(wanted)) {
        return `不支持的推理强度「${wanted}」。可选：${[...REASONING_CHOICES, 'default'].join(' | ')}`
      }
      const holders = requireAgent(ev)
      if (holders.error !== undefined) return holders.error
      const { agent, chatKey } = holders
      const previous = currentSelectionOf(agent, chatKey)
      if (previous === null) {
        return '当前会话还没有固定模型，请先用 /qq-model <provider>/<model> 选择模型，再调推理强度。'
      }
      const reasoningEffort = wanted === 'default' ? undefined : wanted
      const resolved = await resolveSelection({
        provider: previous.provider,
        model: previous.model,
        reasoningEffort,
      })
      if (resolved.error !== undefined) return resolved.error
      installSelection(agent, resolved.selection)
      await store.setSelection(chatKey, { reasoning: reasoningEffort ?? null })
      return wanted === 'default'
        ? '已恢复该模型的默认推理强度。下一轮生效。'
        : `已将会话推理强度设为 ${wanted}。下一轮生效。`
    },

    '/qq-title': async ({ cmd, ev }) => {
      const title = cmd.positional.join(' ').trim()
      if (title === '') return '用法：/qq-title <新标题>'
      const holders = requireAgent(ev)
      if (holders.error !== undefined) return holders.error
      const titles = ctx.get?.('sessionTitle')
      if (titles === null || titles === undefined || typeof titles.rename !== 'function') {
        return '当前部署没有 sessionTitle 服务，无法重命名。'
      }
      try {
        const accepted = titles.rename(holders.agent.session, title)
        return `已将会话重命名为「${accepted?.title ?? title}」。`
      } catch (error) {
        return `重命名失败：${error instanceof Error ? error.message : String(error)}`
      }
    },

    // ── P4：登录 / 登出 / 重连 / 配对批准 ──────────────────────────

    '/qq-login': async ({ cmd, ev }) => {
      // 协议自带登录引导的 transport（登录由外部程序负责）不走扫码流程
      if (typeof transport.loginHint === 'function') {
        return transport.loginHint()
      }
      const existing = await resolveCredentials(ctx)
      const status = typeof transport.status === 'function' ? transport.status() : {}
      if (existing !== null && cmd.flags.has('--force') !== true) {
        if (status.connected === true) {
          return `已登录（AppID ${status.accountId || existing.appId}，来源 ${existing.source}）。重新扫码请用 /qq-login --force。`
        }
        const started = await restartTransport()
        return started
          ? `凭据已就绪（来源 ${existing.source}），正在连接（当前 ${transport.status().phase}）。`
          : `凭据已就绪但连接失败：${transport.status().lastError || '未知原因'}`
      }
      if (onboarding === null || typeof onboarding.begin !== 'function') {
        return '当前部署未启用扫码登录（onboarding 不可用）；请在 DSH 设置/凭据里写入 QQ_APP_ID 与 QQ_CLIENT_SECRET。'
      }
      let began
      try {
        began = await onboarding.begin()
      } catch (error) {
        return `创建扫码任务失败：${error instanceof Error ? error.message : String(error)}`
      }
      // 后台等待扫码结果（不阻塞命令回复）
      const wait = async () => {
        const result = await onboarding.wait({ taskId: began.taskId, key: began.key, signal: scope?.signal })
        if (result === null) {
          await notify(ev, '扫码登录未完成（超时/二维码多次过期）。可再次 /qq-login 重试。')
          return null
        }
        try {
          await saveCredentials(ctx, { appId: result.appId, clientSecret: result.clientSecret })
        } catch (error) {
          await notify(ev, `扫码成功但凭据保存失败：${error instanceof Error ? error.message : String(error)}`)
          return null
        }
        await store.setAccountId(result.appId)
        if (result.userOpenId !== '' && store.homeChannel() === '') await store.setHomeChannel(result.userOpenId)
        if (typeof onCredentialsChanged === 'function') {
          try {
            onCredentialsChanged({ appId: result.appId, userOpenId: result.userOpenId })
          } catch {
            /* 钩子失败不影响登录结果 */
          }
        }
        await notify(ev, `扫码登录成功（AppID ${result.appId}）。正在连接 QQ 网关…`)
        const started = await restartTransport()
        await notify(
          ev,
          started
            ? `已连接（${transport.status().phase}）。发一条消息试试，例如 ping。`
            : `连接失败：${transport.status().lastError || '未知原因'}`,
        )
        return result
      }
      if (scope !== null && typeof scope.run === 'function') scope.run(wait, 'dsh-qq: qr login wait')
      else void wait()
      return [
        '请在**手机 QQ** 里打开下面的链接完成机器人绑定（10 分钟内有效）：',
        began.url,
        '',
        '绑定完成后我会在这里通知你，无需再发命令。',
      ].join('\n')
    },

    '/qq-logout': async () => {
      await transport.stop()
      const removed = await clearCredentials(ctx)
      await store.setAccountId('')
      return removed
        ? '已清除本地凭据并断开连接。重新登录：/qq-login'
        : '已断开连接（未发现可清除的本地凭据——凭据可能来自环境变量）。'
    },

    '/qq-reconnect': async () => {
      const started = await restartTransport()
      const status = transport.status()
      return started ? `正在重连（当前 ${status.phase}）。` : `重连失败：${status.lastError || '未知原因'}`
    },

    '/qq-approve': async ({ cmd, ev }) => {
      const userId = (cmd.positional[0] ?? '').trim()
      if (userId === '') {
        const pending = store.pendingPairing()
        const list = pending.length === 0 ? '当前没有待批准的申请。' : `待批准：${pending.map(item => item.id).join('、')}`
        return `用法：/qq-approve <openid>\n${list}`
      }
      await store.addAuthorized(userId, { role: 'authorized' })
      const notified = await notify({ target: { kind: 'dm', userId } }, `你已被批准与 DSH 对话。发送消息即可开始（/qq-help 查看命令）。`)
      void ev
      return `已批准 ${userId}。${notified ? '已通知对方。' : '（通知未送达，对方发消息时仍可正常使用）'}`
    },
  }

  /** 重启 transport（登录/登出/重连共用）：stop → start。 */
  async function restartTransport() {
    try {
      await transport.stop()
    } catch (error) {
      log.warn(`dsh-qq: transport.stop 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const started = await transport.start({ signal: scope?.signal })
      return started === true
    } catch (error) {
      log.warn(`dsh-qq: transport.start 失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 向某个 target 发一条通知（尽力而为，失败不抛）。 */
  async function notify(ev, text) {
    if (ev === null || ev === undefined || ev.target === null || ev.target === undefined) return false
    try {
      const result = await transport.sendText(ev.target, text, {})
      return result?.ok === true
    } catch (error) {
      log.warn(`dsh-qq: 通知发送失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 记录配对申请（P4 会补上给管理员的主动通知）。 */
  async function requestPairing(ev) {
    const entry = await store.addPendingPairing({ userId: ev.sender.id, name: ev.sender.name })
    const owner = store.homeChannel()
    let notified = false
    if (owner !== '' && transport !== null && typeof transport.sendText === 'function') {
      try {
        const result = await transport.sendText(
          { kind: 'dm', userId: owner },
          `QQ 用户 ${ev.sender.name || ev.sender.id}（${ev.sender.id}）请求与 DSH 对话。\n同意请回复：/qq-approve ${ev.sender.id}`,
          {},
        )
        notified = result?.ok === true
      } catch (error) {
        log.warn(`dsh-qq: 配对通知发送失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      pending: entry,
      notified,
      reply:
        entry === null
          ? '你已在授权列表中，请重试。'
          : '已收到你的请求，等待管理员批准。' + (notified ? '（已通知管理员）' : ''),
    }
  }

  /**
   * 安装审批 answerer：把 DSH 的审批请求转发到 QQ 并等待决策。
   * 只认领本插件托管会话发出的审批；其他会话一律 next() 交给别的 answerer。
   * @returns {() => void} disposer
   */
  function installApprovalAnswerer() {
    // `approval/request` 同样是作用域事件（Scoped<Agent>）：挂在插件 ctx 上收不到。
    // 挂到 root（所有 agent 作用域的祖先）再按「是否本插件托管的会话」过滤认领。
    const host = typeof ctx.root?.on === 'function' ? ctx.root : ctx
    if (typeof host.on !== 'function') return () => {}
    const dispose = host.on('approval/request', async (req, next) => {
      const sessionId = String(req?.agent?.session?.id ?? '')
      const chatKey = sessionId === '' ? null : bridge.chatKeyForSession(sessionId)
      if (chatKey === null) return next()
      const target = typeof bridge.targetForChat === 'function' ? bridge.targetForChat(chatKey) : null
      if (target === null) return next()

      const toolName = String(req?.toolName ?? 'unknown')
      const reason = String(req?.reason ?? '').trim()
      const record = approval.create({
        sessionId,
        chatKey,
        allowedUserId: approverFor(target),
        summary: `${toolName}${reason === '' ? '' : `：${reason}`}`,
        target,
      })
      const caption = [
        '⚠️ DSH 需要你批准一次敏感操作',
        `工具：${toolName}`,
        ...(reason === '' ? [] : [`原因：${reason}`]),
        '',
        `审批号：${record.approvalId}（5 分钟内有效）`,
        '点击下方按钮，或回复 approve / deny。',
      ].join('\n')

      try {
        if (capabilities().keyboard === true && typeof transport.sendKeyboard === 'function') {
          await transport.sendKeyboard(
            target,
            caption,
            [
              { label: '允许', data: approval.buttonData(record.approvalId, 'allow') },
              { label: '拒绝', data: approval.buttonData(record.approvalId, 'deny') },
            ],
            {},
          )
        } else {
          await transport.sendText(target, caption, {})
        }
      } catch (error) {
        log.warn(`dsh-qq: 审批消息发送失败：${error instanceof Error ? error.message : String(error)}`)
        return next()
      }

      const outcome = await waitForDecision(record, req?.signal)
      return outcome
    })
    return dispose
  }

  /** 等待审批决策：轮询注册表 + 尊重取消信号 + 超时 fail-closed。 */
  function waitForDecision(record, signal) {
    const deadline = record.expiresAt
    return new Promise(resolve => {
      if (signal?.aborted === true) return resolve('cancelled')
      const finish = outcome => {
        const waiter = waiters.get(record.approvalId)
        if (waiter !== undefined) {
          clearInterval(waiter.timer)
          waiters.delete(record.approvalId)
        }
        if (signal !== undefined && onAbort !== null) signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = signal === undefined ? null : () => finish('cancelled')
      if (signal !== undefined && onAbort !== null) signal.addEventListener('abort', onAbort, { once: true })
      const timer = setInterval(() => {
        const current = approval.get(record.approvalId)
        if (current === null) return finish('unavailable')
        if (current.consumed === true) return finish(current.decision === 'deny' ? 'rejected' : 'allowed-once')
        if (current.expiresAt <= Date.now()) return finish('unavailable')
      }, 250)
      // 刻意不 unref：等待决策是一笔未完成的真实操作，必须让事件循环保持活跃；
      // 插件卸载时由 ResourceScope 统一清理（见下方 waiters 清理）。
      waiters.set(record.approvalId, { timer, finish })
      if (deadline <= Date.now()) finish('unavailable')
    })
  }

  /** 审批允许者：私聊=对话对方（owner 的 QQ），群/频道=home channel 绑定的 owner。 */
  function approverFor(target) {
    if (target.kind === 'dm') return target.userId
    return store.homeChannel()
  }

  /**
   * 注册到 DSH 命令系统（Web 侧可发现；QQ 侧由 router 直接执行，不进模型）。
   * @param {object} commandsService - ctx.commands
   * @returns {() => void} disposer
   */
  function registerCommands(commandsService) {
    if (commandsService === undefined || commandsService === null || typeof commandsService.register !== 'function') {
      log.warn('dsh-qq: commands 服务不可用，/qq-* 仅在 QQ 侧可用')
      return () => {}
    }
    const disposers = []
    for (const spec of COMMAND_SPECS) {
      const pending = PENDING_PHASE[spec.name]
      try {
        disposers.push(
          commandsService.register({
            name: spec.name.slice(1),
            description: `${spec.description}（QQ 渠道命令）`,
            handler: async () => {
              // 渠道无关的命令允许在 DSH 会话里直接执行（首次登录尤其需要：
              // 那时 QQ 侧还没有能对话的机器人，只能从 Web 侧发起扫码）
              if (WEB_EXECUTABLE.has(spec.name)) {
                const result = await execute(parseCommand(spec.usage.replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '')), WEB_EVENT, {
                  role: 'owner',
                })
                return { kind: 'success', text: result.reply }
              }
              return {
                kind: 'success',
                text: `${spec.usage} — ${spec.description}${pending === undefined ? '' : `［${pending} 启用］`}\n这是会话相关命令，请在对应的 QQ 对话里发送。`,
              }
            },
          }),
        )
      } catch (error) {
        log.warn(`dsh-qq: 注册命令 ${spec.name} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return () => {
      while (disposers.length > 0) {
        try {
          disposers.pop()()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * 执行一条本地命令。
   * @param {{name: string, positional: string[], flags: Set<string>, raw: string}} cmd
   * @param {object} ev - 归一化入站事件。
   * @param {{role: string}} [context]
   * @returns {Promise<{reply: string}>}
   */
  async function execute(cmd, ev, context = {}) {
    const spec = specs.get(cmd.name)
    if (spec === undefined) return { reply: `未知命令 ${cmd.name}。用 /qq-help 查看可用命令。` }
    if (!roleAllows(config.controlPolicy, policyKeyOf(spec.action), context.role ?? 'everyone')) {
      return { reply: `无权限执行 ${cmd.name}。` }
    }
    const handler = handlers[cmd.name]
    if (handler === undefined) {
      const phase = PENDING_PHASE[cmd.name] ?? '后续阶段'
      return { reply: `${cmd.name} 尚未启用（计划 ${phase} 实现）。当前可用：/qq-help` }
    }
    try {
      const reply = await handler({ cmd, ev, ...deps })
      return { reply: String(reply ?? '') }
    } catch (error) {
      log.warn(`dsh-qq: 命令 ${cmd.name} 执行失败：${error instanceof Error ? error.message : String(error)}`)
      return { reply: `命令执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 文本审批入口（router 或其他路径可调用）。 */
  async function handleApprovalText(ev, decision) {
    const result = approval.decideByText({
      actorId: ev.sender.id,
      chatKey: ev.chatKey,
      sessionId: bridge.currentSession(ev.chatKey),
      decision,
    })
    if (result.ok === false) {
      return result.reason === 'ambiguous'
        ? '当前有多个待审批请求，请点击对应消息下方的按钮。'
        : result.reason === 'none'
          ? '当前没有待审批请求。'
          : `审批失败（${result.reason}）。`
    }
    return result.outcome === 'allowed-once' ? '已允许本次操作。' : '已拒绝本次操作。'
  }

  if (scope !== null) {
    scope.add(() => {
      for (const [id, waiter] of waiters) {
        clearInterval(waiter.timer)
        waiters.delete(id)
      }
      for (const [, entry] of selections) {
        try {
          entry.dispose()
        } catch {
          /* ignore */
        }
      }
      selections.clear()
    }, 'dsh-qq: approval waiters / selections')
  }

  return {
    isLocal: name => specs.has(name),
    actionOf: name => policyKeyOf(specs.get(name)?.action ?? 'chat'),
    listCommands: () => COMMAND_SPECS.map(spec => ({ ...spec })),
    registerCommands,
    execute,
    installSelection,
    ensureSelection,
    applyStoredSelection,
    defaultSelection,
    currentSelectionOf,
    requestPairing,
    installApprovalAnswerer,
    handleApprovalText,
    /**
     * 文本审批入口（没有消息按钮的通道）：只有该 chat 真的有本人在等的审批时才认领，
     * 否则返回 null 让消息照常走对话链路（避免把「不要」「no」这类日常用语当审批）。
     * @param {object} ev - 归一化入站事件
     * @param {'allow'|'deny'} decision
     * @returns {Promise<string|null>} 回复文案，或 null（没有待审批）
     */
    async tryApprovalText(ev, decision) {
      const sessionId = bridge.currentSession(ev.chatKey)
      const candidates = approval.pending({ chatKey: ev.chatKey, sessionId, actorId: ev.sender.id })
      if (candidates.length === 0) return null
      return handleApprovalText(ev, decision)
    },
    handleApprovalButton: async (data, ev, decision) => {
      const parsed = approval.parseButtonData(data)
      if (parsed === null) return null
      const result = approval.decide({
        approvalId: parsed.approvalId,
        nonce: parsed.nonce,
        decision,
        actorId: ev.sender.id,
        chatKey: ev.chatKey,
        sessionId: bridge.currentSession(ev.chatKey),
      })
      if (result.ok === false) return `审批失败（${result.reason}）。`
      return result.outcome === 'allowed-once' ? '已允许本次操作。' : '已拒绝本次操作。'
    },
    /** 测试与诊断用。 */
    _waiters: waiters,
  }
}

function formatPolicy(policy) {
  return Object.entries(policy)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

export default createControl
