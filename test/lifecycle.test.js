import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getPluginHandle } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import { createResourceScope } from '../lib/scope.js'
import { assertTransportContract, createUnavailableTransport } from '../lib/transport.js'
import { createMockTransport } from '../lib/mock.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-qq-life-'))

async function boot(overrides = {}, services = {}) {
  const dir = await tempDir()
  const agents = services.agents ?? createFakeAgents()
  const ctx = createFakeCtx({ services: { agents, ...services } })
  await apply(ctx, { transport: 'mock', autoConnect: true, dataDir: dir, ...overrides })
  return { ctx, plugin: getPluginHandle(ctx), agents, dir }
}

test('apply 装配：契约完整、渠道注册、命令注册、审批 answerer', async () => {
  const registered = []
  const commands = {
    register(definition) {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    async execute() {
      return { result: { kind: 'success', text: 'ok' } }
    },
  }
  const { ctx, plugin } = await boot({}, { commands })
  await plugin.ready
  assert.equal(assertTransportContract(plugin.transport), true)
  assert.equal(plugin.transport.status().connected, true, 'autoConnect 应已连接 mock transport')
  assert.equal(globalThis.__dshChannelNotify.qq !== undefined, true)
  assert.equal(typeof globalThis.__dshChannelNotify.qq.send, 'function')
  assert.equal(typeof globalThis.__dshChannelNotify.qq.recentChat, 'function')
  assert.equal(registered.length, plugin.control.listCommands().length)
  assert.equal(ctx.listenerCount('approval/request'), 1)
  await ctx.dispose()
  assert.equal(globalThis.__dshChannelNotify.qq, undefined)
})

test('渠道注册表条目：send 解析目标、非法目标如实报错', async () => {
  const { ctx, plugin } = await boot()
  const entry = globalThis.__dshChannelNotify.qq
  const ok = await entry.send({ kind: 'p2p', id: 'u1' }, 'hello')
  assert.equal(ok.ok, true)
  const last = plugin.transport.dump().at(-1)
  assert.equal(last.kind, 'text')
  assert.deepEqual(last.target, { kind: 'dm', userId: 'u1' })

  const bad = await entry.send({ kind: 'p2p', id: '' }, 'hi')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /无法解析发送目标/)

  const group = await entry.send({ kind: 'group', id: 'g1' }, 'hi')
  assert.equal(group.ok, true)
  assert.deepEqual(plugin.transport.dump().at(-1).target, { kind: 'group', groupId: 'g1' })

  const status = entry.status()
  assert.equal(status.kind, 'mock')
  assert.equal(status.connected, true)
  await ctx.dispose()
  assert.equal(globalThis.__dshChannelNotify.qq, undefined)
})

test('端到端（mock transport）：入站 → 会话 → 回复；命令不建会话', async () => {
  const { ctx, plugin, agents } = await boot()
  await plugin.store.setHomeChannel('owner-1')

  plugin.transport.injectText('ping', { target: { kind: 'dm', userId: 'owner-1' }, sender: { id: 'owner-1', name: 'O' } })
  await tick(40)
  assert.equal(agents.created.length, 1)
  const agent = agents.live.get(agents.created[0].sessionId)
  assert.equal(agent.followed.length, 1)

  agent.reply('pong')
  agent.ctx.emitStatus('idle')
  await tick(40)
  assert.equal(plugin.transport.lastText(), 'pong')

  const before = agents.created.length
  plugin.transport.injectText('/qq-help', { target: { kind: 'dm', userId: 'owner-1' }, sender: { id: 'owner-1', name: 'O' } })
  await tick(40)
  assert.equal(agents.created.length, before, '控制命令不得创建会话')
  assert.match(plugin.transport.lastText(), /dsh-qq 命令/)
  await ctx.dispose()
})

test('enable/disable × 20：无监听器泄漏、渠道注册表干净、scope 归零', async () => {
  const dir = await tempDir()
  for (let index = 0; index < 20; index += 1) {
    const agents = createFakeAgents()
    const ctx = createFakeCtx({ services: { agents } })
    await apply(ctx, { transport: 'mock', autoConnect: true, dataDir: dir })
    const plugin = getPluginHandle(ctx)
    assert.equal(globalThis.__dshChannelNotify.qq !== undefined, true, `第 ${index + 1} 轮应已注册`)
    assert.equal(ctx.listenerCount('approval/request'), 1)
    await ctx.dispose()
    assert.equal(globalThis.__dshChannelNotify.qq, undefined, `第 ${index + 1} 轮卸载后应清理注册表`)
    assert.equal(ctx.listenerCount('approval/request'), 0)
    assert.deepEqual(plugin.scope.stats, { cleanups: 0, timers: 0, tasks: 0 }, `第 ${index + 1} 轮资源应全部释放`)
    assert.equal(plugin.scope.disposed, true)
  }
})

test('多实例：旧实例卸载不误删新实例的注册表条目（评审 §9）', async () => {
  const bootA = await boot()
  const bootB = await boot()
  const entryB = globalThis.__dshChannelNotify.qq
  await bootA.ctx.dispose()
  assert.equal(globalThis.__dshChannelNotify.qq, entryB, 'A 卸载后 B 的条目必须保留')
  await bootB.ctx.dispose()
  assert.equal(globalThis.__dshChannelNotify.qq, undefined)
})

test('qqbot transport 缺凭据时降级运行，不阻塞插件加载', async () => {
  const dir = await tempDir()
  const agents = createFakeAgents()
  const logger = createLogger()
  const ctx = createFakeCtx({ services: { agents }, logger })
  const savedId = process.env.QQ_APP_ID
  const savedSecret = process.env.QQ_CLIENT_SECRET
  delete process.env.QQ_APP_ID
  delete process.env.QQ_CLIENT_SECRET
  try {
    await apply(ctx, { transport: 'qqbot', autoConnect: true, dataDir: dir })
    const plugin = getPluginHandle(ctx)
    await plugin.ready
    const status = plugin.transport.status()
    assert.equal(status.connected, false)
    assert.equal(status.phase, 'no-credentials')
    assert.ok(logger.entries.warn.some(line => line.includes('未配置凭据')), '应记录缺凭据原因')
    // 命令仍可用
    const reply = await plugin.control.execute(
      { name: '/qq-status', positional: [], flags: new Set(), raw: '/qq-status' },
      { chatKey: 'qqbot:1:dm:u', sender: { id: 'u', name: 'U' }, target: { kind: 'dm', userId: 'u' } },
      { role: 'owner' },
    )
    assert.match(reply.reply, /未连接/)
    await ctx.dispose()
  } finally {
    if (savedId === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = savedId
    if (savedSecret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = savedSecret
  }
})

test('transport 模块不存在时降级为 unavailable（未知 transport 的出口）', async () => {
  // loader 表只登记已实现的 transport；这里直接验证降级实现本身的契约与行为
  const unavailable = createUnavailableTransport('altmock', '模块加载失败：模拟')
  assert.equal(assertTransportContract(unavailable), true)
  assert.equal(unavailable.status().phase, 'unavailable')
  assert.equal(unavailable.status().connected, false)
  const failed = await unavailable.sendText({ kind: 'dm', userId: 'u1' }, 'hi')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /模拟/)
})

test('配置非法时 apply 拒绝（fail-fast）', async () => {
  const ctx = createFakeCtx({})
  await assert.rejects(() => apply(ctx, { transport: 'nope' }), /transport must be one of/)
  await assert.rejects(() => apply(ctx, { maxQueuedMessagesPerChat: 0 }), /maxQueuedMessagesPerChat/)
  await assert.rejects(() => apply(ctx, { unknownKey: 1 }), /unknown keys/)
  await assert.rejects(() => apply(ctx, { controlPolicy: { modelControl: 'root' } }), /controlPolicy.modelControl/)
})

test('ResourceScope：LIFO 清理、定时器清理、任务等待', async () => {
  const scope = createResourceScope({ name: 'unit' })
  const order = []
  scope.add(() => order.push('first'), 'first')
  scope.add(() => order.push('second'), 'second')
  let ticks = 0
  scope.timer(() => {
    ticks += 1
  }, 5, { repeat: true })
  await tick(20)
  assert.ok(ticks > 0, '定时器应触发')
  const task = scope.run(async signal => {
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(signal.aborted, true, 'dispose 应 abort 信号')
    order.push('task')
  })
  await scope.dispose()
  await task
  assert.deepEqual(order, ['second', 'first', 'task'])
  assert.deepEqual(scope.stats, { cleanups: 0, timers: 0, tasks: 0 })
  const after = ticks
  await tick(15)
  assert.equal(ticks, after, 'dispose 后定时器不得再触发')
  // 已释放的 scope 再 add：立即执行而非泄漏
  let late = false
  scope.add(() => {
    late = true
  }, 'late')
  await tick(5)
  assert.equal(late, true)
})

test('resolveConfig：默认值完整且冻结', () => {
  const config = resolveConfig({})
  assert.equal(config.transport, 'qqbot')
  assert.equal(config.autoConnect, true)
  assert.equal(config.maxQueuedMessagesPerChat, 8)
  assert.equal(config.controlPolicy.modelControl, 'owner')
  assert.ok(Object.isFrozen(config))
  assert.ok(config.dataDir.includes('qq-adapter'))
})

test('mock transport 契约与调试辅助', async () => {
  const transport = createMockTransport({ capabilities: { keyboard: false } })
  assert.equal(transport.capabilities().keyboard, false)
  const received = []
  transport.onMessage(ev => received.push(ev))
  const ev = transport.injectText('hi')
  assert.equal(received.length, 1)
  assert.equal(ev.chatKey, 'mock:mock:dm:mock-user')
  await transport.sendText({ kind: 'dm', userId: 'mock-user' }, 'out')
  assert.equal(transport.lastText(), 'out')
  assert.deepEqual(transport.recentChat(), { kind: 'p2p', id: 'mock-user' })
  transport.reset()
  assert.equal(transport.dump().length, 0)
})

test('渠道直发：de_channel_send 的纯文本走 sendMedia 槽位（{kind:text,content}）也要能发出去', async () => {
  const { ctx, plugin } = await boot()
  await plugin.ready
  const entry = globalThis.__dshChannelNotify.qq

  // DSH 的 de_channel_send 约定：无附件时 sends = [{kind:'text', content}]，仍调 entry.sendMedia
  const textResult = await entry.sendMedia({ kind: 'p2p', id: 'u1' }, { kind: 'text', content: '直发文本' })
  assert.equal(textResult.ok, true, '文本必须经 sendMedia 槽位也能发出')
  const sent = plugin.transport.dump().filter(item => item.kind === 'text')
  assert.equal(sent.at(-1).text, '直发文本')

  // 媒体仍然走 transport.sendMedia
  const mediaResult = await entry.sendMedia({ kind: 'p2p', id: 'u1' }, { kind: 'image', base64: 'AAAA' })
  assert.equal(mediaResult.ok, true)
  assert.equal(plugin.transport.dump().at(-1).kind, 'media')

  // 空文本如实报错，不静默
  const empty = await entry.sendMedia({ kind: 'p2p', id: 'u1' }, { kind: 'text', content: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /文本为空/)
  await ctx.dispose()
})

test('账号命名空间随 transport 同步：切协议后 store.accountId 必须更新（不是只在空时写一次）', async () => {
  const dir = await tempDir()
  const ctx1 = createFakeCtx({ services: { agents: createFakeAgents() } })
  await apply(ctx1, { transport: 'mock', autoConnect: false, dataDir: dir })
  const first = getPluginHandle(ctx1)
  await first.store.setAccountId('stale-official-appid')
  await ctx1.dispose()

  const ctx2 = createFakeCtx({ services: { agents: createFakeAgents() } })
  await apply(ctx2, { transport: 'mock', autoConnect: true, dataDir: dir })
  const second = getPluginHandle(ctx2)
  await second.ready
  assert.equal(second.store.accountId(), 'mock', '新 transport 的账号应覆盖旧值')
  await ctx2.dispose()
})
