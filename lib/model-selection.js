/**
 * 会话级模型选择（从 control.js 拆出）。
 *
 * 负责：
 *   - 把用户显式选择（/qq-model、/qq-reasoning）安装到 agent 作用域：
 *     改写下一请求、同步提示词变量、写 model/selection 事件；
 *   - 默认选择回退链：会话持久化选择 → 插件 agentOptions → DSH 全局默认；
 *   - 模型不可用自愈（清失效选择 + 本次运行回退全局默认）。
 *
 * 铁律（v0.2.7）：**默认选择绝不写回 store**，store 只存用户显式选择。
 */

/** 模型不可用类错误：缺凭据、provider 路由不存在、推理强度不支持。 */
const MODEL_UNAVAILABLE_RE = /no API key|MISSING_CREDENTIAL|provider route|unknown provider|UNSUPPORTED_|does not support/i

/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.config
 * @param {object} deps.store
 * @param {object} deps.log
 */
export function createModelSelection({ ctx, config, store, log }) {
  /** sessionId → 已安装的选择 {provider, model, reasoningEffort, dispose} */
  const selections = new Map()
  /** 渠道默认模型不可用时的进程内回退标记（见 recoverFromModelFailure）。 */
  let configuredFallback = false

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

  /** 卸载时释放所有已安装监听。 */
  function dispose() {
    for (const [, entry] of selections) {
      try {
        entry.dispose()
      } catch {
        /* ignore */
      }
    }
    selections.clear()
  }

  return {
    currentSelectionOf,
    listProviders,
    resolveSelection,
    installSelection,
    storedSelection,
    configuredSelection,
    defaultSelection,
    isModelUnavailable,
    recoverFromModelFailure,
    ensureSelection,
    applyStoredSelection,
    dispose,
    /** 测试与诊断用。 */
    _selections: selections,
  }
}
