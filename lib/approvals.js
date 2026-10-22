/**
 * 审批转发与配对申请（从 control.js 拆出）。
 *
 * 职责：
 *   - 把 DSH 的 `approval/request` 转发到 QQ（按钮或文本），并等待用户决策；
 *   - 配对申请（陌生用户请求聊天 → 通知主人 + 落 store）；
 *   - 文本/按钮两种审批入口。
 *
 * 只依赖 store / transport / bridge / approval 与一个 capabilities 读函数，
 * 不关心命令解析与会话管理——这样审批逻辑可以独立测，control 也能瘦下来。
 */

/** 待批申请里留存的首条消息上限（字符）：只用于批准后补答，不当作归档。 */
const PENDING_MESSAGE_MAX_CHARS = 1000


/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.store
 * @param {object} deps.transport
 * @param {object} deps.bridge
 * @param {object} deps.approval
 * @param {() => object} [deps.capabilities] - transport.capabilities()（按钮能力判断）
 * @param {object} deps.log
 */
export function createApprovals({ ctx, store, transport, bridge, approval, capabilities = () => ({ keyboard: false }), log }) {
  /** approvalId → { timer, finish }（等待用户决策） */
  const waiters = new Map()

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

  /** 无按钮通道（个人号）：只有该 chat 真有本人在等的审批才认领。 */
  async function tryApprovalText(ev, decision) {
    const sessionId = bridge.currentSession(ev.chatKey)
    const candidates = approval.pending({ chatKey: ev.chatKey, sessionId, actorId: ev.sender.id })
    if (candidates.length === 0) return null
    return handleApprovalText(ev, decision)
  }

  /** 按钮回调入口。 */
  async function handleApprovalButton(data, ev, decision) {
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
  }

  /** 插件卸载时清掉所有等待中的审批定时器。 */
  function dispose() {
    for (const [id, waiter] of waiters) {
      clearInterval(waiter.timer)
      waiters.delete(id)
    }
  }

  return {
    requestPairing,
    installApprovalAnswerer,
    handleApprovalText,
    tryApprovalText,
    handleApprovalButton,
    dispose,
    /** 测试与诊断用。 */
    _waiters: waiters,
  }
}
