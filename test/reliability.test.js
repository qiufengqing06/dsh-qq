import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { createResourceScope } from '../lib/scope.js'
import {
  createFetchImpl,
  createSocketFactory,
  createTransport,
  resolveProxyUrl,
} from '../lib/qqbot.js'
import { startFakeQQServer } from './helpers/fake-qq-server.js'
import { createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

/** 假 socket（浏览器式 API），用于验证代理注入。 */
function createFakeSocketClass(record) {
  return class FakeSocket {
    constructor(url, options) {
      record.push({ url, options })
      this.listeners = new Map()
      queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(event, listener) {
      this.listeners.set(event, listener)
    }
    removeEventListener(event) {
      this.listeners.delete(event)
    }
    emit(event, payload) {
      this.listeners.get(event)?.(payload)
    }
    send() {}
    close() {}
  }
}

test('resolveProxyUrl：优先级 WSS_PROXY → HTTPS_PROXY → ALL_PROXY', () => {
  assert.equal(resolveProxyUrl({}), '')
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://p1' }), 'http://p1')
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://p1', ALL_PROXY: 'http://p2' }), 'http://p1')
  assert.equal(resolveProxyUrl({ WSS_PROXY: 'http://w', HTTPS_PROXY: 'http://p1' }), 'http://w')
})

test('createSocketFactory：直连用内置 WebSocket；代理时注入 ws + https-proxy-agent', async () => {
  const record = []
  const FakeSocket = createFakeSocketClass(record)
  const agents = []
  const factory = createSocketFactory({
    proxyLoader: async () => ({
      WebSocket: FakeSocket,
      HttpsProxyAgent: class FakeAgent {
        constructor(url) {
          agents.push(url)
        }
      },
    }),
  })

  const proxied = await factory('wss://gateway.example/ws', { proxyUrl: 'http://127.0.0.1:7890' })
  assert.ok(proxied instanceof FakeSocket, '代理路径必须使用 ws 客户端')
  assert.deepEqual(agents, ['http://127.0.0.1:7890'], '必须显式传代理 agent（ws 不会自动读环境变量）')
  assert.equal(record.at(-1).options.agent instanceof Object, true)

  // 直连：走内置 WebSocket（替换全局实现，避免真实联网）
  const savedWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket
  try {
    const direct = await factory('wss://gateway.example/ws', { proxyUrl: '' })
    assert.ok(direct instanceof FakeSocket, '直连路径必须用内置 WebSocket')
  } finally {
    globalThis.WebSocket = savedWebSocket
  }
})

test('createSocketFactory：代理依赖缺失时给出可操作错误', async () => {
  const factory = createSocketFactory({
    proxyLoader: async () => {
      throw new Error('Cannot find package ws')
    },
  })
  await assert.rejects(
    () => factory('wss://gw', { proxyUrl: 'http://127.0.0.1:7890' }),
    /代理已配置.*ws \/ https-proxy-agent 不可用/s,
  )
  const badExports = createSocketFactory({ proxyLoader: async () => ({}) })
  await assert.rejects(() => badExports('wss://gw', { proxyUrl: 'http://p' }), /未提供可用的导出/)
})

test('createFetchImpl：无代理透传；有代理且 undici 可用时挂 dispatcher；不可用时告警一次', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url, init })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const direct = createFetchImpl({ proxyProvider: () => '' })
    await direct('https://a.example')
    assert.equal(seen.at(-1).init.dispatcher, undefined)

    const ProxyAgent = class {
      constructor(url) {
        this.url = url
      }
    }
    const proxied = createFetchImpl({
      proxyProvider: () => 'http://127.0.0.1:7890',
      dispatcherLoader: async () => ({ ProxyAgent }),
    })
    await proxied('https://b.example', { method: 'POST' })
    assert.ok(seen.at(-1).init.dispatcher instanceof ProxyAgent, '应挂 undici dispatcher')
    assert.equal(seen.at(-1).init.dispatcher.url, 'http://127.0.0.1:7890')

    const logger = createLogger()
    const fallback = createFetchImpl({
      proxyProvider: () => 'http://127.0.0.1:7890',
      dispatcherLoader: async () => {
        throw new Error('undici not installed')
      },
      logger,
    })
    await fallback('https://c.example')
    await fallback('https://d.example')
    assert.equal(seen.at(-1).init.dispatcher, undefined, 'undici 不可用时直连')
    assert.equal(logger.entries.warn.filter(line => line.includes('undici')).length, 1, '只告警一次')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 故障注入：token / 网关 / REST 失败路径 ──

async function setupTransport({ serverOptions = {}, deps = {}, configOverrides = {} } = {}) {
  const server = await startFakeQQServer(serverOptions)
  const saved = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  process.env.QQ_APP_ID = 'app-fi'
  process.env.QQ_CLIENT_SECRET = 'secret-fi'
  const config = resolveConfig({ transport: 'qqbot', autoConnect: false, ...configOverrides })
  const ctx = createFakeCtx({})
  const scope = createResourceScope({ name: 'fault' })
  const logger = createLogger()
  const transport = createTransport({
    config,
    ctx,
    scope,
    logger,
    deps: {
      socketFactory: server.socketFactory,
      apiBase: server.apiBase,
      tokenUrl: server.tokenUrl,
      backoffMs: [5, 5, 5],
      proxyUrl: '',
      ...deps,
    },
  })
  const restore = () => {
    if (saved.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = saved.id
    if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = saved.secret
  }
  return { server, config, ctx, scope, logger, transport, restore }
}

test('故障注入：token 401 时如实报错并进入重试，达上限后 disconnected', async t => {
  const env = await setupTransport({ serverOptions: { failToken: true }, deps: { maxReconnectAttempts: 1 } })
  t.after(async () => {
    await env.scope.dispose()
    await env.server.close()
    env.restore()
  })
  const started = await env.transport.start()
  assert.equal(started, false)
  await tick(80)
  const status = env.transport.status()
  assert.ok(['reconnecting', 'disconnected'].includes(status.phase), status.phase)
  assert.match(status.lastError, /token HTTP 401/)
  assert.equal(status.connected, false)
})

test('故障注入：网关 500 与畸形帧都不崩溃', async t => {
  const env = await setupTransport({ deps: { maxReconnectAttempts: 1 } })
  t.after(async () => {
    await env.scope.dispose()
    await env.server.close()
    env.restore()
  })
  env.server.setRestResponse('/gateway', { status: 500, body: { message: 'gateway down' } })
  await env.transport.start()
  await tick(80)
  assert.ok(
    env.logger.entries.warn.some(line => /gateway HTTP 500/.test(line)),
    `日志应记录网关失败：${env.logger.entries.warn.join(' | ')}`,
  )
  assert.equal(env.transport.status().connected, false)
  // 畸形帧 / 未知 op / 空数据：不得抛出
  assert.doesNotThrow(() => env.transport._injectPayload('not-json'))
  assert.doesNotThrow(() => env.transport._injectPayload({ op: 99, d: null }))
  assert.doesNotThrow(() => env.transport._injectPayload({ op: 0, t: 'UNKNOWN_EVENT', d: {} }))
})

test('故障注入：REST 500/429 返回可重试标记，未连接时不发请求', async t => {
  const env = await setupTransport()
  t.after(async () => {
    await env.scope.dispose()
    await env.server.close()
    env.restore()
  })
  const cold = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, 'x', {})
  assert.equal(cold.ok, false)
  assert.equal(cold.retryable, true)

  await env.transport.start()
  await tick(40)
  env.server.setRestResponse('/v2/users/u1/', { status: 503, body: { message: 'busy' } })
  const failed = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, 'x', {})
  assert.equal(failed.ok, false)
  assert.equal(failed.retryable, true)
  assert.equal(failed.status, 503)
})

test('密钥不泄漏：secret / token 不出现在日志、状态与错误里', async t => {
  const secret = 'SUPER-SECRET-VALUE-9911'
  const env = await setupTransport({ serverOptions: { failToken: true }, deps: { maxReconnectAttempts: 0 } })
  t.after(async () => {
    await env.scope.dispose()
    await env.server.close()
    env.restore()
  })
  process.env.QQ_CLIENT_SECRET = secret
  await env.transport.start()
  await tick(60)

  const surface = JSON.stringify({
    logs: env.logger.entries,
    status: env.transport.status(),
    credentials: env.transport._credentials(),
    state: env.transport._state(),
  })
  assert.equal(surface.includes(secret), false, 'secret 绝不出现在任何对外表面')
  assert.ok(surface.includes('app-fi'), 'AppID 可以出现（非机密）')
  // 显式检查脱敏函数
  assert.match(JSON.stringify(env.logger.entries), /invalid appid or secret|token HTTP 401/)
})

// ── lifecycle 压力：反复 start/stop 不泄漏、不留连接 ──

test('lifecycle 压力：15 轮 start/stop 后无残留连接、scope 归零', async () => {
  for (let round = 0; round < 15; round += 1) {
    const env = await setupTransport()
    try {
      await env.transport.start()
      await tick(20)
      assert.equal(env.transport.status().connected, true, `第 ${round + 1} 轮应连接成功`)
      await env.transport.stop()
      assert.equal(env.server.sockets.size, 0, `第 ${round + 1} 轮 stop 后不应残留连接`)
      await env.scope.dispose()
      assert.deepEqual(
        env.scope.stats,
        { cleanups: 0, timers: 0, tasks: 0 },
        `第 ${round + 1} 轮 scope 应完全释放`,
      )
    } finally {
      await env.server.close()
      env.restore()
    }
  }
})

test('代理凭据不泄漏：user:pass@ 代理 URL 在日志与状态里被抹掉', async () => {
  const { redactProxy, createSocketFactory } = await import('../lib/qqbot.js')
  assert.equal(redactProxy('http://user:s3cret@proxy.local:7890'), 'http://***@proxy.local:7890')
  assert.equal(redactProxy('socks5://a:b@10.0.0.1:1080'), 'socks5://***@10.0.0.1:1080')
  assert.equal(redactProxy('http://proxy.local:7890'), 'http://proxy.local:7890')

  const record = []
  const logger = createLogger()
  const factory = createSocketFactory({
    proxyLoader: async () => ({
      WebSocket: createFakeSocketClass(record),
      HttpsProxyAgent: class {
        constructor(url) {
          this.url = url
        }
      },
    }),
    logger,
  })
  await factory('wss://gw', { proxyUrl: 'http://user:s3cret@proxy.local:7890' })
  assert.equal(JSON.stringify(logger.entries).includes('s3cret'), false, '代理密码不得进日志')
  assert.ok(logger.entries.info.some(line => line.includes('***@proxy.local')))

  const failure = createSocketFactory({
    proxyLoader: async () => {
      throw new Error('Cannot find module ws')
    },
  })
  await assert.rejects(
    () => failure('wss://gw', { proxyUrl: 'http://user:s3cret@proxy.local:7890' }),
    error => {
      assert.equal(String(error.message).includes('s3cret'), false, '错误消息不得含代理密码')
      return true
    },
  )
})

test('传输状态里的 proxy 字段已脱敏', async t => {
  const env = await setupTransport({ deps: { proxyUrl: 'http://user:s3cret@proxy.local:7890' } })
  t.after(async () => {
    await env.scope.dispose()
    await env.server.close()
    env.restore()
  })
  assert.equal(env.transport.status().proxy, 'http://***@proxy.local:7890')
})
