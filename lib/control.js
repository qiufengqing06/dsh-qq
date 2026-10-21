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
import { makeInboundEvent } from './transport.js'

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
  { name: '/qq-config', action: 'chat', usage: '/qq-config', description: '查看当前配置与 Web 配置页地址' },
])

const PENDING_PHASE = Object.freeze({})

/** 待批申请里留存的首条消息上限（字符）：只用于批准后补答，不当作归档。 */
const PENDING_MESSAGE_MAX_CHARS = 1000
/** 超过这个时长就不再补答首条消息（隔夜的老问题重放出来只会让人困惑）。 */
const PENDING_REPLAY_TTL_MS = 30 * 60 * 1000

/** 不依赖 QQ 会话上下文、可在 DSH 会话里直接执行的命令。 */
const WEB_EXECUTABLE = new Set(['/qq-help', '/qq-status', '/qq-login', '/qq-logout', '/qq-reconnect', '/qq-config'])

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
  /** Web 配置页 URL 的 getter（未挂载 webServer 时返回 null）。 */
  configPageUrl = null,
}) {
  const specs = new Map(COMMAND_SPECS.map(spec => [spec.name, spec]))
  /** approvalId → resolve（等待用户决策） */
  const waiters = new Map()

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
  /** 渠道默认模型不可用时的进程内回退标记（见 recoverFromModelFailure）。 */
  let configuredFallback = false

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

  /**
   * 插件级默认选择（配置 `agentOptions.provider/model/reasoningEffort`）。
   *
   * 为什么需要它、并且要优先于 DSH 全局默认：QQ 渠道的默认模型是**渠道自己的事**——
   * 真机反馈（2026-09-24）：QQ 侧每次重启都回到 mimo/high，用户要的是 deepseek-flash/low，
   * 而 Web 全局默认是 deepseek-flash/off，两边诉求不同。配置了就按配置走，没配才回落全局。
   * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
   */
  function configuredSelection() {
    const options = config.agentOptions
    if (options === null || options === undefined) return null
    if (typeof options.provider !== 'string' || options.provider === '') return null
    if (typeof options.model !== 'string' || options.model === '') return null
    return {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
    }
  }

  /** 无会话级选择时的默认：插件配置 agentOptions → DSH 全局默认模型。 */
  function defaultSelection() {
    // configuredFallback：本次运行里渠道默认模型被证明不可用（缺凭据/路由不存在），
    // 临时跳过 agentOptions、回退 DSH 全局默认；重启或改配置后自动重新尝试。
    if (!configuredFallback) {
      const configured = configuredSelection()
      if (configured !== null) return configured
    }
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
   * 会话就绪时**必须**安装模型选择（优先级：本 chat 的**用户显式选择** → 插件配置的默认 → DSH 全局默认）。
   *
   * 为什么必须：persona 等提示词模板引用 `{{provider}}` / `{{model}}`，而这两个变量由
   * 模型选择安装器提供（Web 会话由 session-controller 装）。QQ 会话若没人装，
   * 提示词组装会直接抛 `prompt variable "{{model}}" has no value`，整轮失败。
   *
   * 注意：**默认值不再写回 store**。旧实现把回落出来的默认选择当成「本 chat 的选择」持久化，
   * 于是默认改了也永远不生效——真机反馈（2026-09-24）：QQ 侧每次重启都回到早已不用的
   * mimo/high，而全局默认早已是 deepseek-flash。store 里只放**用户显式选择**
   * （/qq-model、/qq-reasoning），这样「默认」才真的是默认。
   */
  /** 模型不可用类错误：缺凭据、provider 路由不存在、推理强度不支持。 */
  const MODEL_UNAVAILABLE_RE = /no API key|MISSING_CREDENTIAL|provider route|unknown provider|UNSUPPORTED_|does not support/i

  /**
   * 本轮失败是否属于「模型不可用」。
   * @param {string} message
   * @returns {boolean}
   */
  function isModelUnavailable(message) {
    return MODEL_UNAVAILABLE_RE.test(String(message ?? ''))
  }

  /**
   * 模型不可用后的自愈：清掉该对话失效的显式选择，并在本次运行内回退到 DSH 全局默认。
   * 返回给用户看的提示（追加在失败消息后面），不需要恢复时返回 null。
   * @param {string} chatKey
   * @param {string} message - 失败原因（session/turn/end 的 reason.error.message）
   * @returns {Promise<string|null>}
   */
  async function recoverFromModelFailure(chatKey, message) {
    if (!isModelUnavailable(message)) return null
    const hadStored = storedSelection(chatKey) !== null
    if (hadStored) await store.setSelection(chatKey, { model: null, reasoning: null })
    const hadConfigured = configuredSelection() !== null
    if (hadConfigured) configuredFallback = true
    log.warn(
      `dsh-qq: 模型不可用（${String(message ?? '').slice(0, 160)}）`
      + `${hadStored ? '；已清除该对话的显式选择' : ''}`
      + `${hadConfigured ? '；本次运行回退到 DSH 全局默认' : ''}`,
    )
    if (!hadStored && !hadConfigured) return '（模型不可用：请用 /qq-model 指定可用模型，或检查 DSH 的模型凭据）'
    return '（该对话的模型配置不可用，已回退到 DSH 全局默认：请再发一次；也可用 /qq-model 指定可用模型）'
  }

  function ensureSelection(agent, chatKey) {
    const stored = storedSelection(chatKey)
    const selection = stored ?? defaultSelection()
    if (selection === null) {
      log.warn('dsh-qq: 既无会话选择也无默认模型，QQ 会话可能无法组装提示词')
      return null
    }
    // 幂等：每条消息都会 ensure 一次，已经装着同一个选择时直接复用，
    // 避免重复注册监听、重复写 model/selection 事件（日志会被刷屏）。
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
    const installed = sessionId === '' ? undefined : selections.get(sessionId)
    const same =
      installed !== undefined
      && installed.provider === selection.provider
      && installed.model === selection.model
      && (installed.reasoningEffort ?? undefined) === (selection.reasoningEffort ?? undefined)
    if (same) return installed
    return installSelection(agent, selection)
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
      ]
      // 多线路：逐条列出真实状态（单线路时和旧输出一致）
      const lineStatuses = Array.isArray(status.lines) ? status.lines : null
      if (lineStatuses !== null && lineStatuses.length > 1) {
        lines.push(`  线路：${lineStatuses.length} 条（${status.connectedCount ?? 0} 条已连接）`)
        for (const line of lineStatuses) {
          const label = line.kind === 'qqbot' ? '官方' : line.kind
          lines.push(
            `    ${label}：${line.connected === true ? '已连接' : '未连接'}`
            + `（${line.phase ?? 'unknown'}）`
            + `${line.accountId === undefined || line.accountId === '' ? '' : ` 账号 ${line.accountId}`}`
            + `${line.lastError === undefined || line.lastError === '' ? '' : ` ⚠ ${line.lastError}`}`,
          )
        }
      } else {
        lines.push(`  传输：${config.transport}（${status.connected === true ? '已连接' : '未连接'}${status.phase === undefined ? '' : ` / ${status.phase}`}）`)
      }
      lines.push(
        `  账号：${status.accountId || store.accountId() || '未配置'}`,
        `  待处理审批：${approval.pending({}).length}`,
      )
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
        const lineHint = typeof transport.loginHintFor === 'function' ? transport.loginHintFor('qqbot') : null
        const hint = lineHint === null || lineHint === undefined ? (typeof transport.loginHint === 'function' ? transport.loginHint() : '') : lineHint
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

    '/qq-config': () => {
      const pageUrl = typeof configPageUrl === 'function' ? configPageUrl() : null
      const agent = config.agentOptions === null || config.agentOptions === undefined ? null : config.agentOptions
      const agentText =
        agent === null || typeof agent.provider !== 'string' || agent.provider === ''
          ? '（跟随 DSH 全局默认）'
          : `${agent.provider}/${String(agent.model ?? '')}${typeof agent.reasoningEffort === 'string' && agent.reasoningEffort !== '' ? `（推理 ${agent.reasoningEffort}）` : ''}`
      const memory = config.groupMemory ?? {}
      const lines = [
        pageUrl === null
          ? '配置页不可用（当前部署未挂载 webServer）——可直接编辑 profile 的 cordis.patch.yml。'
          : `Web 配置页（浏览器打开，可看可改，保存后自动热重载）：\n  ${pageUrl}`,
        '',
        `传输：${config.transport}（autoConnect=${config.autoConnect === true}）`,
        `群聊：mentionRequired=${config.mentionRequired === true}，freeReplyGroups=[${(config.freeReplyGroups ?? []).join(', ')}]`,
        `渠道默认模型：${agentText}`,
        `群记忆：${memory.enabled === true ? `开（缓冲 ${memory.bufferMessages} 条 / 上下文 ${memory.contextMaxChars} 字 / 笔记上限 ${memory.notesMaxChars} 字）` : '关'}`,
        '备份与凭据：/qq-status；凭据不进聊天、也不在配置页显示。',
      ]
      return lines.join('\n')
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
            // **回读确认**：DSH 0.1.7 起 saveSelection() 把默认模型交给 profile 配置编辑器落盘
            // （`ctx.get('configEditor')?.edit(...)`）——没有编辑器时它是**静默 no-op**，
            // 不抛错、也不改 currentSelection()。凭「没抛错」就报成功就是这个项目最忌讳的
            // 「写了不生效」；所以这里回读比对，不一致就如实说（真机踩点：2026-09-25 DSH 升级）。
            const applied = typeof defaultModel.currentSelection === 'function' ? defaultModel.currentSelection() : null
            const ok =
              applied !== null &&
              applied !== undefined &&
              applied.provider === resolved.selection.provider &&
              applied.model === resolved.selection.model
            if (ok) {
              extra = '，并已设为全局默认'
            } else {
              const editor = ctx.get?.('configEditor')
              const hasEditor = editor !== null && editor !== undefined && typeof editor.edit === 'function'
              extra = hasEditor
                ? '（全局默认未生效：写入后回读不一致，请检查 profile 配置是否可写）'
                : '（全局默认未写入：当前 DSH 未挂载 configEditor；QQ 渠道默认请用插件配置 agentOptions）'
            }
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
      await store.setSelection(chatKey, {
        // 必须连模型一起落库：自 v0.2.6 起默认选择不再写回 store，只记 reasoning 的话
        // storedSelection() 会因缺 model 而返回 null，用户刚设的强度下次就丢了。
        model: `${previous.provider}/${previous.model}`,
        reasoning: reasoningEffort ?? null,
      })
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
      // 协议自带登录引导的线路不走扫码流程：按命令来源的那条线判断该给什么提示。
      const sourceLine = typeof transport.forKind === 'function' && ev?.transportKind !== undefined ? transport.forKind(ev.transportKind) : null
      const hint =
        sourceLine !== null && typeof sourceLine.transport.loginHint === 'function'
          ? sourceLine.transport.loginHint()
          : typeof transport.loginHint === 'function'
            ? transport.loginHint()
            : null
      if (hint !== null) {
        return hint
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
      const began = await beginQrLogin(ev)
      if (began.error !== undefined) return began.error
      if (began.url === undefined || began.url === '') {
        return `扫码登录已在进行中（${began.already ?? '等待绑定'}）。`
      }
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
        const list =
          pending.length === 0
            ? '当前没有待批准的申请。'
            : `待批准：${pending.map(item => (item.transportKind === undefined ? item.id : `${item.id}（${item.transportKind}）`)).join('、')}`
        return `用法：/qq-approve <openid>\n${list}`
      }
      // 批准前先取出申请里留存的首条消息：addAuthorized 会把待批条目清掉
      const pendingEntry = store.pendingPairing().find(item => item.id === userId) ?? null
      // 授权记录必须落到申请来源的 transport 命名空间，否则切到另一条线又变成陌生人
      await store.addAuthorized(userId, { role: 'authorized', transportKind: pendingEntry?.transportKind ?? null })
      const replay = buildPendingReplay(userId, pendingEntry)
      const notified = await notify(
        { target: { kind: 'dm', userId } },
        replay === null
          ? '你已被批准与 DSH 对话。发送消息即可开始（/qq-help 查看命令）。'
          : '你已被批准与 DSH 对话。你刚才那条消息我现在就来答，回复稍后到。',
      )
      void ev
      return {
        reply: `已批准 ${userId}。${replay === null ? '' : '已补答其首条消息。'}${notified ? '已通知对方。' : '（通知未送达，对方发消息时仍可正常使用）'}`,
        // 补答事件由 index.js 走 router（入站唯一入口）投递，control 不自己绕过去
        ...(replay === null ? {} : { replay }),
      }
    },
  }

  /**
   * 把待批申请里留存的首条消息还原成归一化入站事件（批准后补答用）。
   *
   * 为什么需要：陌生人的首条消息只换来一句「等待管理员批准」，若批准时直接丢掉，
   * 用户必须把问题再发一遍才有回应（真机反馈 2026-09-24）。
   *
   * 只补答**新鲜**（{@link PENDING_REPLAY_TTL_MS} 内）且**非空文本**的消息：
   * 媒体是带鉴权的临时链接，隔一段时间重放只会得到「获取失败」，不如不补。
   * @param {string} userId
   * @param {object|null} entry - store.pendingPairing() 里的条目
   * @returns {object|null} 归一化入站事件
   */
  function buildPendingReplay(userId, entry) {
    const message = entry?.message ?? null
    if (message === null || typeof message.text !== 'string' || message.text.trim() === '') return null
    if (Date.now() - Number(entry?.lastAt ?? 0) > PENDING_REPLAY_TTL_MS) return null
    const target = message.target ?? null
    if (target === null || typeof target !== 'object') return null
    const accountId = store.accountId() || config.accountId || ''
    if (accountId === '') return null
    try {
      return makeInboundEvent({
        transportKind: config.transport,
        accountId,
        target,
        sender: { id: userId, name: entry?.name ?? '' },
        text: message.text,
        messageId: '',
        timestamp: Date.now(),
        media: [],
        replyTo: null,
        // 能走到配对说明这条消息已经过了群 @ 闸门（非 @ 的群消息在闸门处就被忽略）
        mentioned: true,
        rawKind: 'pairing-replay',
      })
    } catch (error) {
      log.warn(`dsh-qq: 补答事件构造失败（${error instanceof Error ? error.message : String(error)}）`)
      return null
    }
  }

  /**
   * 开始一次官方扫码登录（/qq-login 命令与 Web 配置页共用）。
   *
   * 成功时返回绑定链接并在后台等待扫码结果（拿到凭据 → 保存 → 重连 → 通知）；
   * 已经配置过凭据时返回「无需扫码」的说明，而不是重复创建绑定任务。
   * @returns {Promise<{url?: string, error?: string, already?: string}>}
   */
  async function beginQrLogin(ev = WEB_EVENT) {
    const sourceLine = typeof transport.forKind === 'function' && ev?.transportKind !== undefined ? transport.forKind(ev.transportKind) : null
    const hint = sourceLine !== null && typeof sourceLine.transport.loginHint === 'function' ? sourceLine.transport.loginHint() : typeof transport.loginHint === 'function' ? transport.loginHint() : null
    if (hint !== null) {
      return { error: hint }
    }
    if (onboarding === null || typeof onboarding.begin !== 'function') {
      return { error: '当前部署未启用扫码登录（onboarding 不可用）；请在 DSH 设置/凭据里写入 QQ_APP_ID 与 QQ_CLIENT_SECRET。' }
    }
    let began
    try {
      began = await onboarding.begin()
    } catch (error) {
      return { error: `创建扫码任务失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const wait = async () => {
      const result = await onboarding.wait({ taskId: began.taskId, key: began.key, signal: scope?.signal })
      if (result === null) {
        await notify(ev, '扫码登录未完成（超时/二维码多次过期）。可再次发起登录。')
        return null
      }
      try {
        await saveCredentials(ctx, { appId: result.appId, clientSecret: result.clientSecret })
      } catch (error) {
        await notify(ev, `扫码成功但凭据保存失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      await store.setAccountId(result.appId)
      if (result.userOpenId !== '' && store.homeChannel('qqbot') === '') await store.setHomeChannel(result.userOpenId, 'qqbot')
      if (typeof onCredentialsChanged === 'function') {
        try {
          onCredentialsChanged({ appId: result.appId, userOpenId: result.userOpenId })
        } catch {
          /* 钩子失败不影响登录结果 */
        }
      }
      log.info(`dsh-qq: 扫码登录成功（AppID ${result.appId}）`)
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
    return { url: began.url }
  }

  /**
   * 以 Web 身份执行一条 /qq-* 命令（配置页的动作按钮用：登录/登出/重连/状态…）。
   * @param {string} line - 例如 '/qq-reconnect'
   * @returns {Promise<{reply: string}>}
   */
  async function executeWeb(line) {
    return execute(parseCommand(line), WEB_EVENT, { role: 'owner' })
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

  /** 记录配对申请，并通知管理员。申请里留存首条消息，批准后可补答（见 buildPendingReplay）。 */
  async function requestPairing(ev) {
    const text = String(ev?.text ?? '').trim()
    const entry = await store.addPendingPairing({
      userId: ev.sender.id,
      name: ev.sender.name,
      transportKind: ev.transportKind ?? null,
      message:
        text === '' || ev.target === null || ev.target === undefined
          ? null
          : { text: text.slice(0, PENDING_MESSAGE_MAX_CHARS), target: ev.target },
    })
    const owner = store.homeChannel(ev.transportKind ?? null)
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
      // DSH 0.1.7-rc 起审批请求会带本地化提示 displayReason（sandbox 升级、auto-review 都会给）：
      // 它是给人读的整句，而 reason 是审计用的 `escalate sandbox to …：<justification>` 机器串。
      // QQ 用户看到前者才像人话；没有它时回落 reason（老宿主 / 其他生产者）。
      const displayReason = approvalDisplayReason(req)
      const record = approval.create({
        sessionId,
        chatKey,
        allowedUserId: approverFor(target, chatKey),
        summary: `${toolName}${displayReason === '' ? (reason === '' ? '' : `：${reason}`) : `：${displayReason}`}`,
        target,
      })
      const caption = [
        '⚠️ DSH 需要你批准一次敏感操作',
        `工具：${toolName}`,
        ...(displayReason !== '' ? [`说明：${displayReason}`] : reason === '' ? [] : [`原因：${reason}`]),
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
  function approverFor(target, chatKey) {
    if (target.kind === 'dm') return target.userId
    // chatKey = `${transportKind}:${accountId}:${kind}:${id}`：群/频道审批只认该 transport 绑定的主人
    const transportKind = typeof chatKey === 'string' && chatKey.includes(':') ? chatKey.split(':')[0] : null
    return store.homeChannel(transportKind)
  }

  /**
   * 取出审批请求里的本地化提示（DSH 0.1.7-rc 新增的 `displayReason`）。
   *
   * DSH 的生产者目前给 `{ en, zh }` 两种（见 packages/sandbox/sandbox/src/escalation.ts：
   * `zh: 允许本次操作使用 <mode> 权限：<justification>`）。QQ 渠道是中文场景，
   * 所以优先 zh 系，其次 en，最后退到任何非空项——locale 键命名若再变也不会整段丢掉。
   * @param {object} req - approval/request 请求
   * @returns {string} 空串 = 该请求没带本地化提示
   */
  function approvalDisplayReason(req) {
    const map = req?.displayReason
    if (map === null || map === undefined || typeof map !== 'object') return ''
    for (const key of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
      const value = map[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    for (const value of Object.values(map)) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
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
      const result = await handler({ cmd, ev, ...deps })
      // 命令结果通常是字符串；需要附带额外投递指令时（如配对批准后的补答事件 replay）
      // 返回 { reply, replay }，这里原样透传给 router/index。
      if (result !== null && typeof result === 'object' && typeof result.reply === 'string') return result
      return { reply: String(result ?? '') }
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
    /** Web 配置页用：以 owner 身份执行一条 /qq-* 命令（登录/登出/重连等动作按钮）。 */
    executeWeb,
    /** Web 配置页用：发起官方扫码登录，返回绑定链接（后台等待扫码结果）。 */
    beginQrLogin,
    /** 模型不可用自愈（bridge 在回合失败时调用）：清失效选择 + 回退全局默认，返回提示文案。 */
    recoverFromModelFailure,
    /** 判断一条失败消息是否属于模型不可用（测试与诊断用）。 */
    isModelUnavailable,
    installSelection,
    ensureSelection,
    applyStoredSelection,
    defaultSelection,
    currentSelectionOf,
    requestPairing,
    installApprovalAnswerer,
    handleApprovalText,
    /**
     * 文本审批入口（无按钮通道）：只有该 chat 真的有本人在等的审批时才认领，
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
