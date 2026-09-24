/**
 * mock transport —— 本地调试用传输（不连 QQ），也是 P0 验收的「mock transport
 * 跑通 router/bridge/control 全链路」载体（执行文档 §7 P0）。
 *
 * 用法（profile 行 config）：
 *   - id: dsh-qq
 *     name: 'dsh-qq'
 *     config: { transport: mock, autoConnect: true }
 *
 * 它实现完整 transport 契约（capabilities/start/stop/status/onMessage/onInteraction/
 * sendText/sendMedia/sendKeyboard/sendTyping），出站消息记录在 `sent` 里可用
 * `dump()` 取出；入站可用 `inject()` / `injectText()` 手工灌入，便于无 QQ 环境下
 * 验证桥接与命令链路。
 */

import { buildChatKey, makeCapabilities, makeInboundEvent } from './transport.js'

/**
 * 创建 mock transport。
 * @param {object} [options]
 * @param {string} [options.accountId]
 * @param {object} [options.capabilities] - 覆盖默认能力表。
 * @param {boolean} [options.failSend] - true 时 sendText 返回失败（测错误路径）。
 * @returns {object} transport（符合 TRANSPORT_SLOTS 契约）
 */
export function createMockTransport({ accountId = 'mock', capabilities: capabilityOverrides = {}, failSend = false } = {}) {
  const capabilities = makeCapabilities({
    markdown: true,
    keyboard: true,
    typing: true,
    passiveReply: true,
    proactiveMessage: true,
    media: ['image', 'file', 'audio'],
    ...capabilityOverrides,
  })
  /** url → {data, contentType} 媒体夹具（离线验证入站附件链路） */
  const mediaFixtures = new Map()
  const messageHandlers = new Set()
  const interactionHandlers = new Set()
  /** @type {Array<object>} 出站记录 */
  const sent = []
  let phase = 'idle'
  let typingCount = 0

  const emit = (handlers, payload) => {
    for (const handler of [...handlers]) {
      try {
        const result = handler(payload)
        if (result !== undefined && typeof result.then === 'function') result.catch(() => {})
      } catch {
        /* 单个 handler 失败不影响其他 */
      }
    }
  }

  const record = entry => {
    sent.push({ ...entry, at: Date.now() })
    return entry
  }

  const transport = {
    kind: 'mock',
    capabilities: () => capabilities,

    async start() {
      phase = 'connected'
      return true
    },
    async stop() {
      phase = 'stopped'
    },
    status: () => ({ connected: phase === 'connected', phase, accountId, kind: 'mock' }),

    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onInteraction(handler) {
      interactionHandlers.add(handler)
      return () => interactionHandlers.delete(handler)
    },

    async sendText(target, text, opts = {}) {
      record({ kind: 'text', target, text, opts })
      if (failSend) return { ok: false, error: 'mock: sendText disabled' }
      return { ok: true, messageId: `mock-${sent.length}` }
    },
    async sendMedia(target, media, opts = {}) {
      record({ kind: 'media', target, media, opts })
      return { ok: true, messageId: `mock-${sent.length}` }
    },
    async sendKeyboard(target, text, buttons, opts = {}) {
      record({ kind: 'keyboard', target, text, buttons, opts })
      return { ok: true, messageId: `mock-${sent.length}` }
    },
    async sendTyping(target) {
      typingCount += 1
      record({ kind: 'typing', target })
      return { ok: true }
    },
    /** 离线媒体下载：默认无夹具（如实报错），用 addMedia 注册。 */
    async downloadMedia(url, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
      const fixture = mediaFixtures.get(String(url))
      if (fixture === undefined) return { ok: false, error: `mock: 未注册媒体 ${url}` }
      if (fixture.data.byteLength > maxBytes) {
        return { ok: false, error: `媒体超过上限（${fixture.data.byteLength} > ${maxBytes} 字节）` }
      }
      return { ok: true, data: fixture.data, contentType: fixture.contentType, bytes: fixture.data.byteLength }
    },
    recentChat() {
      for (let index = sent.length - 1; index >= 0; index -= 1) {
        const entry = sent[index]
        if (entry.kind !== 'typing' && entry.target !== undefined) {
          if (entry.target.kind === 'dm') return { kind: 'p2p', id: entry.target.userId }
          if (entry.target.kind === 'group') return { kind: 'group', id: entry.target.groupId }
        }
      }
      return null
    },

    // ── 调试/测试辅助（不属于契约） ────────────────────────────────
    /** 手工灌入归一化入站事件（缺省私聊 sender 本人）。 */
    inject(spec) {
      const sender = spec.sender ?? { id: 'mock-user', name: 'Mock' }
      const target = spec.target ?? { kind: 'dm', userId: sender.id }
      const event = makeInboundEvent({ transportKind: 'mock', accountId, ...spec, sender, target })
      emit(messageHandlers, event)
      return event
    },
    /** 便捷：发一条文本消息（默认私聊 mock 用户）。 */
    injectText(text, { target = { kind: 'dm', userId: 'mock-user' }, sender = { id: 'mock-user', name: 'Mock' }, mentioned = false, messageId } = {}) {
      return transport.inject({ text, target, sender, mentioned, messageId })
    },
    /** 触发一次交互回调（审批按钮）。 */
    clickButton(data, { target = { kind: 'dm', userId: 'mock-user' }, sender = { id: 'mock-user', name: 'Mock' } } = {}) {
      const payload = {
        data,
        chatKey: buildChatKey('mock', accountId, target),
        target,
        sender,
        transportKind: 'mock',
        accountId,
      }
      emit(interactionHandlers, payload)
      return payload
    },
    dump: () => sent.map(entry => ({ ...entry })),
    lastText: () => [...sent].reverse().find(entry => entry.kind === 'text')?.text ?? null,
    typingCount: () => typingCount,
    /** 注册一个媒体夹具（离线验证入站附件）。 */
    addMedia(url, { data, contentType = 'application/octet-stream' }) {
      mediaFixtures.set(String(url), { data: Buffer.from(data), contentType })
      return mediaFixtures.get(String(url))
    },
    reset: () => {
      sent.length = 0
      typingCount = 0
    },
  }

  return transport
}

export default createMockTransport

/**
 * 标准 transport 工厂（index.js 按 config.transport === 'mock' 加载）。
 * @param {object} spec
 * @param {object} [spec.config]
 * @returns {object} transport
 */
export function createTransport({ config } = {}) {
  return createMockTransport({ accountId: config?.accountId || 'mock' })
}
