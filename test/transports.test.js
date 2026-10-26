/**
 * 多线路 transport 注册表验收。
 *
 * 关键行为：
 * - 单线路部署与旧版行为一致（注册表退化为一层直通）；
 * - 出站按 target 找到所属线路（启动时从 store 冷启动索引，入站再刷新）；
 * - 聚合 status 沿用单 transport 字段，lines() 给每条线路的真实状态；
 * - capabilitiesFor(target) 按线路返回（官方线支持 markdown/typing，个人号纯文本）；
 * - restart(kind) 只动那一条线。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createTransportRegistry, expandLineSpecs } from '../lib/transports.js'
import { createLogger } from './helpers/fake-ctx.js'

/** 假 transport：记录出站消息，可手动灌入站事件。 */
function fakeTransport(kind, options = {}) {
  const sent = []
  const handlers = new Set()
  let connected = options.connected !== false
  const calls = []
  return {
    kind,
    sent,
    calls,
    capabilities: () => ({ markdown: kind === 'qqbot', keyboard: kind === 'qqbot', typing: kind === 'qqbot', media: ['image'], passiveReply: true, proactiveMessage: true }),
    async start() {
      calls.push('start')
      connected = true
      return true
    },
    async stop() {
      calls.push('stop')
      connected = false
    },
    status: () => ({ connected, phase: connected ? 'connected' : 'disconnected', kind, accountId: options.accountId ?? `${kind}-acct` }),
    onMessage(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    onInteraction: () => () => {},
    async sendText(target, text) {
      sent.push({ target, text })
      return { ok: true }
    },
    async sendMedia(target, media) {
      sent.push({ target, media })
      return { ok: true }
    },
    async sendKeyboard(target, text) {
      sent.push({ target, text })
      return { ok: true }
    },
    async sendTyping() {
      return { ok: true }
    },
    async downloadMedia() {
      return { ok: false, error: 'fake' }
    },
    hasCredentials: () => true,
    receive(ev) {
      for (const handler of handlers) handler(ev)
    },
  }
}

const logger = createLogger()

function configOf(extra = {}) {
  return resolveConfig({ autoConnect: false, ...extra })
}

async function makeRegistry({ kind = 'single', extraConfig = {}, transports = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-transports-'))
  const store = createStore({ dir })
  await store.load()
  const built = new Map()
  const config = configOf(extraConfig)
  const registry = await createTransportRegistry({
    ctx: { get: () => undefined },
    config,
    scope: { signal: undefined },
    log: logger,
    store,
    loadTransport: async ({ config: lineConfig }) => {
      const lineKind = lineConfig.transport
      const instance = (transports ?? new Map())?.get(lineKind) ?? fakeTransport(lineKind)
      built.set(lineKind, instance)
      return instance
    },
  })
  return { dir, store, config, registry, built }
}

test('expandLineSpecs：省略 transports 时用 transport 单线；数组时逐线展开并过滤 disabled', () => {
  const single = expandLineSpecs(configOf({ transport: 'onebot' }))
  assert.equal(single.length, 1)
  assert.equal(single[0].kind, 'onebot')
  assert.equal(single[0].config.transport, 'onebot')

  const multi = expandLineSpecs(configOf({ transports: [{ kind: 'qqbot' }, { kind: 'onebot' }, { kind: 'mock', enabled: false }] }))
  assert.deepEqual(multi.map(line => line.kind), ['qqbot', 'onebot'])
  assert.equal(multi[0].config.transport, 'qqbot')
})

test('配置校验：transports 的重复线路 / 未知键 / 全禁用都被拒绝', () => {
  assert.throws(() => configOf({ transports: [{ kind: 'qqbot' }, { kind: 'qqbot' }] }), /重复线路/)
  assert.throws(() => configOf({ transports: [{ kind: 'qqbot', nope: 1 }] }), /unknown keys/)
  assert.throws(() => configOf({ transports: [{ kind: 'qqbot', enabled: false }] }), /全部 enabled:false/)
  assert.throws(() => configOf({ transports: [] }), /非空数组/)
  assert.throws(() => configOf({ transports: [{ kind: 'nope' }] }), /must be one of/)
})

test('单线路部署：注册表行为与旧版一致（路由到唯一线路）', async () => {
  const { registry, built } = await makeRegistry({ extraConfig: { transport: 'onebot' } })
  assert.equal(registry.kind, 'onebot')
  const line = built.get('onebot')
  await registry.sendText({ kind: 'dm', userId: 'u1' }, 'hi')
  assert.deepEqual(line.sent[0], { target: { kind: 'dm', userId: 'u1' }, text: 'hi' })
  assert.equal(registry.status().connected, true)
  assert.equal(registry.status().lineCount, 1)
})

test('多线路：入站记住 target 归属，出站发回对应线路', async () => {
  const { registry, built } = await makeRegistry({ extraConfig: { transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] } })
  const qq = built.get('qqbot')
  const onebot = built.get('onebot')
  // remember 在 onMessage 的包装层里：先注册入站监听（index.js 里的真实用法也是这样）
  registry.onMessage(() => {})

  // 官方线来了一条私聊
  qq.receive({ chatKey: 'qqbot:app:dm:openid-1', transportKind: 'qqbot', target: { kind: 'dm', userId: 'openid-1' }, text: 'hi' })
  await registry.sendText({ kind: 'dm', userId: 'openid-1' }, 'reply')
  assert.equal(qq.sent.length, 1, '官方线的 target 应走官方线')
  assert.equal(onebot.sent.length, 0)

  // 个人线来了一条群消息
  onebot.receive({ chatKey: 'onebot:100002:group:100003', transportKind: 'onebot', target: { kind: 'group', groupId: '100003' }, text: 'yo' })
  await registry.sendText({ kind: 'group', groupId: '100003' }, '群回复')
  assert.equal(onebot.sent.length, 1, '个人线的 target 应走个人线')
  assert.equal(qq.sent.length, 1)
})

test('多线路：启动时从 store 的历史对话冷启动路由（插件重载后也能发对线路）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-transports-seed-'))
  const store = createStore({ dir })
  await store.load()
  // 与 bridge 实际持久化格式一致：渠道 target（p2p/group + id），不是结构化 target
  await store.touch('onebot:100002:group:100003', { target: { kind: 'group', id: '100003' } })

  const built = new Map()
  const registry = await createTransportRegistry({
    ctx: { get: () => undefined },
    config: configOf({ transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] }),
    scope: { signal: undefined },
    log: logger,
    store,
    loadTransport: async ({ config }) => {
      const instance = fakeTransport(config.transport)
      built.set(config.transport, instance)
      return instance
    },
  })
  await registry.sendText({ kind: 'group', groupId: '100003' }, '很久以前聊过的群')
  assert.equal(built.get('onebot').sent.length, 1)
  assert.equal(built.get('qqbot').sent.length, 0)
})

test('多线路：同一 target 跨线路 → 无显式线路时拒绝发送，带 route 时才路由', async () => {
  const { registry, built } = await makeRegistry({ extraConfig: { transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] } })
  registry.onMessage(() => {})
  const qq = built.get('qqbot')
  const onebot = built.get('onebot')
  // 同一个群号同时出现在两条线路上（两条线都有这个群）
  qq.receive({ transportKind: 'qqbot', target: { kind: 'group', groupId: 'same-group' }, text: 'a' })
  onebot.receive({ transportKind: 'onebot', target: { kind: 'group', groupId: 'same-group' }, text: 'b' })

  const ambiguous = await registry.sendText({ kind: 'group', groupId: 'same-group' }, '不知道发哪条')
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /多条线路/)
  assert.equal(qq.sent.length, 0)
  assert.equal(onebot.sent.length, 0)

  const routed = await registry.sendText(
    { kind: 'group', groupId: 'same-group' },
    '显式走个人线',
    { transportKind: 'onebot', accountId: '100002' },
  )
  assert.equal(routed.ok, true)
  assert.equal(onebot.sent.length, 1)
  assert.equal(qq.sent.length, 0)
})

test('聚合状态：一条通一条断 → connected=true / phase=partial / lines 各自真实', async () => {
  const built = new Map()
  const registry = await createTransportRegistry({
    ctx: { get: () => undefined },
    config: configOf({ transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] }),
    scope: { signal: undefined },
    log: logger,
    store: null,
    loadTransport: async ({ config }) => {
      const instance = fakeTransport(config.transport, { connected: config.transport === 'qqbot' })
      built.set(config.transport, instance)
      return instance
    },
  })
  const status = registry.status()
  assert.equal(status.connected, true)
  assert.equal(status.phase, 'partial')
  assert.equal(status.connectedCount, 1)
  assert.equal(status.lineCount, 2)
  assert.equal(status.kind, 'multi')
  assert.deepEqual(status.lines.map(line => line.kind), ['qqbot', 'onebot'])
  assert.equal(status.lines.find(line => line.kind === 'onebot').connected, false)
})

test('能力按线路：官方线支持 markdown/typing，个人线纯文本', async () => {
  const { registry, built } = await makeRegistry({ extraConfig: { transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] } })
  registry.onMessage(() => {})
  built.get('qqbot').receive({ transportKind: 'qqbot', target: { kind: 'dm', userId: 'openid-1' } })
  built.get('onebot').receive({ transportKind: 'onebot', target: { kind: 'group', groupId: 'g1' } })
  assert.equal(registry.capabilitiesFor({ kind: 'dm', userId: 'openid-1' }).markdown, true)
  assert.equal(registry.capabilitiesFor({ kind: 'group', groupId: 'g1' }).markdown, false)
  // 没有归属记录的 target 回落到最近入站线路，再回落到第一条
  assert.equal(registry.capabilitiesFor({ kind: 'dm', userId: 'unknown' }).markdown, false)
})

test('restart(kind)：只重启指定线路', async () => {
  const { registry, built } = await makeRegistry({ extraConfig: { transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] } })
  built.get('qqbot').calls.length = 0
  built.get('onebot').calls.length = 0
  await registry.restart('onebot')
  assert.deepEqual(built.get('onebot').calls, ['stop', 'start'])
  assert.deepEqual(built.get('qqbot').calls, [])
  await registry.restart()
  assert.ok(built.get('qqbot').calls.length > 0, '不传 kind 时重启所有线路')
})

test('onMessage 解绑：disposer 能移除所有线路的监听', async () => {
  const { registry, built } = await makeRegistry({ extraConfig: { transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] } })
  const seen = []
  const dispose = registry.onMessage(ev => seen.push(ev.transportKind))
  built.get('qqbot').receive({ transportKind: 'qqbot', target: { kind: 'dm', userId: 'u1' } })
  built.get('onebot').receive({ transportKind: 'onebot', target: { kind: 'group', groupId: 'g1' } })
  assert.deepEqual(seen, ['qqbot', 'onebot'])
  dispose()
  built.get('qqbot').receive({ transportKind: 'qqbot', target: { kind: 'dm', userId: 'u2' } })
  assert.deepEqual(seen, ['qqbot', 'onebot'], '解绑后不再收到')
})

test('没有启用任何线路时如实报错（配置层同步拒绝；注册表层兜底）', async () => {
  assert.throws(() => configOf({ transports: [{ kind: 'qqbot', enabled: false }, { kind: 'onebot', enabled: false }] }), /全部 enabled:false/)
  // 直接绕过 resolveConfig 构造一个「全禁用」配置，验证注册表自己的兜底
  const config = { ...configOf({}), transports: [{ kind: 'qqbot', enabled: false }] }
  await assert.rejects(
    () =>
      createTransportRegistry({
        ctx: { get: () => undefined },
        config,
        scope: { signal: undefined },
        log: logger,
        store: null,
        loadTransport: async () => fakeTransport('mock'),
      }),
    /没有任何启用的线路/,
  )
})
