import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createResourceScope } from '../lib/scope.js'
import { createApprovalRegistry } from '../lib/approval.js'
import { createBridge } from '../lib/bridge.js'
import { createControl } from '../lib/control.js'
import { createRouter } from '../lib/router.js'
import { assertTransportContract, makeCapabilities, makeInboundEvent } from '../lib/transport.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

/**
 * 第二 transport 实现（mock）：只实现 transport 契约，用来验证上层不做
 * `kind === 'qqbot'` 判断。事件形状与官方协议不同（private/group → dm/group），
 * 能力更弱：无 keyboard、无 typing、无 markdown。
 */
function createSecondMock({ accountId = '10001' } = {}) {
  const handlers = new Set()
  const interactionHandlers = new Set()
  const sent = []
  let connected = false
  return {
    kind: 'altmock',
    capabilities: () =>
      makeCapabilities({ markdown: false, keyboard: false, typing: false, passiveReply: true, proactiveMessage: true, media: ['image', 'file'] }),
    async start() {
      connected = true
      return true
    },
    async stop() {
      connected = false
    },
    status: () => ({ connected, phase: connected ? 'connected' : 'stopped', kind: 'altmock', accountId }),
    onMessage(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    onInteraction(handler) {
      interactionHandlers.add(handler)
      return () => interactionHandlers.delete(handler)
    },
    /** 灌入一条该实现风格的事件（post_type=message）。 */
    inject(raw) {
      const isGroup = raw.message_type === 'group'
      const event = makeInboundEvent({
        transportKind: 'altmock',
        accountId,
        target: isGroup ? { kind: 'group', groupId: String(raw.group_id) } : { kind: 'dm', userId: String(raw.user_id) },
        sender: { id: String(raw.user_id), name: String(raw.sender?.nickname ?? '') },
        text: String(raw.raw_message ?? ''),
        messageId: String(raw.message_id ?? ''),
        timestamp: Number(raw.time ?? 0) * 1000,
        mentioned: true,
      })
      for (const handler of [...handlers]) handler(event)
      return event
    },
    async sendText(target, text) {
      sent.push({ kind: 'text', target, text })
      return { ok: true, messageId: `ob-${sent.length}` }
    },
    async sendMedia(target, media) {
      sent.push({ kind: 'media', target, media })
      return { ok: true, messageId: `ob-${sent.length}` }
    },
    async sendKeyboard() {
      return { ok: false, error: '第二实现 实现未声明 keyboard 能力' }
    },
    async sendTyping() {
      return { ok: false, error: '第二实现 实现未声明 typing 能力' }
    },
    recentChat() {
      const last = [...sent].reverse().find(entry => entry.target !== undefined)
      if (last === undefined) return null
      return last.target.kind === 'dm' ? { kind: 'p2p', id: last.target.userId } : { kind: 'group', id: last.target.groupId }
    },
    dump: () => sent.map(entry => ({ ...entry })),
  }
}

async function setup第二实现() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-altmock-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir })
  const store = createStore({ dir })
  await store.load()
  const transport = createSecondMock({})
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents } })
  const scope = createResourceScope({ name: 'altmock' })
  const logger = createLogger()
  const approval = createApprovalRegistry({})
  const bridge = createBridge({ ctx, config, store, transport, scope, logger })
  const control = createControl({ ctx, config, store, bridge, transport, approval, scope, logger })
  const router = createRouter({ config, store, control, bridge, logger })
  await store.setHomeChannel('10001')
  const disposeAnswerer = control.installApprovalAnswerer()
  scope.add(disposeAnswerer, 'test: approval answerer')
  return { config, store, transport, agents, ctx, scope, logger, approval, bridge, control, router }
}

test('第二实现 mock 满足 transport 契约（升级空间基线）', async () => {
  const env = await setup第二实现()
  assert.equal(assertTransportContract(env.transport), true)
  const caps = env.transport.capabilities()
  assert.equal(caps.keyboard, false)
  assert.equal(caps.markdown, false)
  assert.equal(caps.typing, false)
  assert.deepEqual([...caps.media], ['image', 'file'])
  await env.scope.dispose()
})

test('第二实现 链路：私聊消息进会话、回复按能力回发、chatKey 带 altmock 命名空间', async () => {
  const env = await setup第二实现()
  const event = env.transport.inject({ post_type: 'message', message_type: 'private', user_id: 10001, raw_message: '你好', message_id: 42, time: 1700000000 })
  assert.equal(event.chatKey, 'altmock:10001:dm:10001', 'chatKey 必须带 transport 命名空间')
  const routed = await env.router.routeInbound(event)
  assert.equal(routed.handled, 'message')
  assert.equal(env.agents.created.length, 1)

  const agent = env.agents.live.get(env.agents.created[0].sessionId)
  agent.reply('收到')
  agent.ctx.emitStatus('idle')
  await new Promise(resolve => setTimeout(resolve, 20))
  const sent = env.transport.dump().at(-1)
  assert.equal(sent.text, '收到')
  assert.deepEqual(sent.target, { kind: 'dm', userId: '10001' })
  await env.scope.dispose()
})

test('第二实现 链路：群消息归一化为 group target；控制命令不进 LLM', async () => {
  const env = await setup第二实现()
  await env.store.addAuthorized('10001', { role: 'owner' })
  const group = env.transport.inject({ post_type: 'message', message_type: 'group', group_id: 555, user_id: 10001, raw_message: '/qq-help', message_id: 7 })
  assert.deepEqual(group.target, { kind: 'group', groupId: '555' })
  const routed = await env.router.routeInbound(group)
  assert.equal(routed.handled, 'command')
  assert.match(routed.reply, /dsh-qq 命令/)
  assert.equal(env.agents.created.length, 0, '控制命令不得创建会话')
  await env.scope.dispose()
})

test('第二实现 链路：审批无键盘能力时自动降级为文本 + 文本回复批准', async () => {
  const env = await setup第二实现()
  const event = env.transport.inject({ post_type: 'message', message_type: 'private', user_id: 10001, raw_message: '跑个命令', message_id: 1 })
  await env.router.routeInbound(event)
  const sessionId = env.agents.created[0].sessionId

  const pending = env.ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'rm -rf build',
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  const sent = env.transport.dump().at(-1)
  assert.equal(sent.kind, 'text', '无 keyboard 能力时必须降级为文本审批')
  assert.match(sent.text, /需要你批准一次敏感操作/)

  const decision = await env.control.handleApprovalText({ chatKey: event.chatKey, sender: { id: '10001' } }, 'allow')
  assert.match(decision, /已允许本次操作/)
  assert.equal(await pending, 'allowed-once')
  await env.scope.dispose()
})

test('第二实现 与 QQBot 的 chatKey 不串（多协议并存基线）', async () => {
  const env = await setup第二实现()
  const altmockEvent = env.transport.inject({ post_type: 'message', message_type: 'private', user_id: 10001, raw_message: 'hi', message_id: 1 })
  const qqbotEvent = makeInboundEvent({
    transportKind: 'qqbot',
    accountId: '10001',
    target: { kind: 'dm', userId: '10001' },
    sender: { id: '10001', name: '' },
    text: 'hi',
  })
  assert.notEqual(altmockEvent.chatKey, qqbotEvent.chatKey)
  await env.router.routeInbound(altmockEvent)
  await env.router.routeInbound(qqbotEvent)
  assert.equal(env.agents.created.length, 2, '同一数字 id 在两个协议下应是两个会话')
  await env.scope.dispose()
})
