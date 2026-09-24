/**
 * 入站 CommandRouter（执行文档 §5.5，设计铁律 #2）。
 *
 * 为什么需要独立 router：DSH 的 `ctx.commands` 只是命令注册表，执行是显式调用
 * `ctx.commands.execute(owner, line, ...)`；Web UI 在消息准入**之前**由客户端调用。
 * QQ 入站链路（transport → bridge → agent.followup）没有这一步，若不拦截，
 * `/qq-model` 会作为普通 prompt 送进模型。因此所有 QQ 入站消息必须先经本 router：
 *
 *   ACL → /qq-* 本地命令（control.js）→ DSH 原生 / 命令（ctx.commands.execute）
 *        → 普通消息（bridge.js → agent.followup）
 *
 * 顺序保证：控制命令绝不进入 LLM context。
 */

import { roleAllows } from './config.js'

/**
 * 解析斜杠命令。
 * @param {string} text
 * @returns {{raw: string, name: string, args: string[], flags: Set<string>, positional: string[]}|null}
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('/')) return null
  const parts = raw.split(/\s+/)
  const head = parts[0].slice(1)
  if (head === '') return null
  const args = parts.slice(1)
  const flags = new Set()
  const positional = []
  for (const arg of args) {
    if (arg.startsWith('--') && arg.length > 2) flags.add(arg.toLowerCase())
    else positional.push(arg)
  }
  return { raw, name: `/${head.toLowerCase()}`, args, flags, positional }
}

/** 去掉 QQ @提及 前缀（协议实现通常会做，这里兜底）。 */
export function stripMention(text) {
  return String(text ?? '')
    .replace(/^\s*<@!?[^>]+>\s*/, '')
    .replace(/^\s*@\S+\s+/, '')
    .trim()
}

/**
 * 创建 router。
 * @param {object} deps
 * @param {object} deps.config - resolveConfig 结果。
 * @param {object} deps.store
 * @param {object} deps.control - control.js 实例。
 * @param {object} deps.bridge - bridge.js 实例。
 * @param {object} [deps.logger]
 * @param {(ev: object, line: string) => Promise<{handled: boolean, reply?: string}|null>} [deps.dshCommand]
 *   DSH 原生 / 命令的执行钩子（内部走 ctx.commands.execute）。
 * @returns {{routeInbound: Function, parseCommand: Function}}
 */
export function createRouter({ config, store, control, bridge, logger = null, dshCommand = null }) {
  const log = {
    info: message => {
      try {
        logger?.info?.(message)
      } catch {
        /* ignore */
      }
    },
  }

  /** 聊天授权角色：open 策略下 everyone 视为 authorized（仅聊天域）。 */
  const chatRoleOf = ev => {
    const role = store.roleOf(ev.sender.id)
    if (config.pairingPolicy === 'open' && role === 'everyone') return 'authorized'
    return role
  }

  const isLocalCommand = name => control.isLocal(name)

  /**
   * 唯一的入站入口。
   * @param {object} ev - 归一化入站事件（transport.makeInboundEvent）。
   * @returns {Promise<{handled: string, reply?: string, reason?: string, command?: string}>}
   */
  async function routeInbound(ev) {
    if (ev === null || typeof ev !== 'object' || typeof ev.chatKey !== 'string') {
      throw new TypeError('routeInbound requires a normalized inbound event')
    }
    const text = stripMention(ev.text)
    const normalized = text === ev.text ? ev : { ...ev, text }
    const command = parseCommand(text)

    // ① 群/频道消息默认必须 @机器人（命令同样要求），否则静默忽略，不给群聊添噪音。
    //    mentionRequired=false，或该群在 freeReplyGroups 白名单里时放开（群里所有消息都回的需求：
    //    群里所有消息都回，而不是只回被 @ 的那条）。
    const groupLike = normalized.target.kind === 'group' || normalized.target.kind === 'channel'
    if (groupLike && normalized.mentioned !== true && !groupReplyAllowed(config, normalized.target)) {
      return { handled: 'ignored', reason: 'not-mentioned' }
    }

    const actorRole = store.roleOf(normalized.sender.id)

    // ② 本地 /qq-* 命令：按控制域权限校验后交给 control（绝不进 LLM）
    if (command !== null && isLocalCommand(command.name)) {
      const action = control.actionOf(command.name)
      if (!roleAllows(config.controlPolicy, action, actorRole)) {
        log.info(`dsh-qq: 命令 ${command.name} 被拒（角色 ${actorRole} < ${config.controlPolicy[action]}）`)
        return {
          handled: 'rejected',
          command: command.name,
          reason: 'forbidden',
          reply: `无权限执行 ${command.name}（需要 ${config.controlPolicy[action]} 角色）。`,
        }
      }
      const result = await control.execute(command, normalized, { role: actorRole })
      return { handled: 'command', command: command.name, ...result }
    }

    // ③ 其他 / 命令：交给 DSH 命令系统（同样不进模型）；不可用时如实回复
    if (command !== null) {
      if (!roleAllows(config.controlPolicy, 'chat', chatRoleOf(normalized))) {
        return await handleUnauthorized(normalized)
      }
      if (typeof dshCommand === 'function') {
        const result = await dshCommand(normalized, command.raw)
        if (result !== null && result !== undefined) {
          return { handled: 'command', command: command.name, reply: result.reply ?? '', dsh: true }
        }
      }
      return {
        handled: 'command-unknown',
        command: command.name,
        reply: `不支持的命令 ${command.name}。用 /qq-help 查看 QQ 命令。`,
      }
    }

    // ③.5 文本审批：没有消息按钮的 transport 只能靠回复文字放行，
    //      必须在普通消息之前拦下，且只在「本对话确实有待审批」时才认领。
    if (command === null) {
      const decision = parseApprovalWord(text)
      if (decision !== null) {
        const replied = await control.tryApprovalText(normalized, decision)
        if (replied !== null) return { handled: 'approval', reply: replied }
      }
    }

    // ④ 普通消息：ACL → 桥接
    if (!roleAllows(config.controlPolicy, 'chat', chatRoleOf(normalized))) {
      return await handleUnauthorized(normalized)
    }
    const bridged = await bridge.handleUserMessage(normalized)
    return { handled: bridged.accepted ? 'message' : 'message-rejected', ...bridged }
  }

  /** 未授权用户：走配对流程（配对策略下），否则如实拒绝。 */
  async function handleUnauthorized(ev) {
    if (config.pairingPolicy === 'open') {
      const bridged = await bridge.handleUserMessage(ev)
      return { handled: bridged.accepted ? 'message' : 'message-rejected', ...bridged }
    }
    const pairing = await control.requestPairing(ev)
    return { handled: 'pairing', reason: 'unauthorized', reply: pairing.reply }
  }

  return { routeInbound, parseCommand }
}

export default createRouter

/**
 * 群聊是否免 @ 回复：全局 mentionRequired=false，或该群在 freeReplyGroups 白名单里。
 * @param {object} config - resolveConfig 结果
 * @param {object} target - 结构化 target
 * @returns {boolean}
 */
function groupReplyAllowed(config, target) {
  if (config?.mentionRequired !== true) return true
  const id = target.kind === 'group' ? target.groupId : `${target.guildId}:${target.channelId}`
  const list = Array.isArray(config?.freeReplyGroups) ? config.freeReplyGroups : []
  return list.includes(id)
}

/** 文本审批关键词（审批消息里承诺的回复方式；大小写不敏感）。 */
const APPROVAL_WORDS = Object.freeze({
  allow: Object.freeze(['approve', 'allow', 'allowed', 'yes', 'y', '允许', '同意', '通过']),
  deny: Object.freeze(['deny', 'reject', 'no', 'n', '拒绝', '不允许', '不同意']),
})

/**
 * 把一条文本解析成审批决定。
 * @param {string} text
 * @returns {'allow'|'deny'|null}
 */
export function parseApprovalWord(text) {
  const word = String(text ?? '').trim().toLowerCase()
  if (word === '' || word.length > 12) return null
  if (APPROVAL_WORDS.allow.includes(word)) return 'allow'
  if (APPROVAL_WORDS.deny.includes(word)) return 'deny'
  return null
}
