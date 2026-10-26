/**
 * 断线看门狗（lib/index.js ⑦）：真机故障「重启 DSH 后 qqbot 默认没启动，
 * 必须手动关开插件才连上」的回归测试。
 *
 * 三种 transport 自己救不回来的状态：
 *   1) 启动竞态——credentials 服务已发布、文档还在异步加载（loadInitial 不派发
 *      credentials/reference-updated，等不到事件），首次解析拿到空凭据；
 *   2) 重连次数耗尽（phase=disconnected）；
 *   3) 致命断开（phase=fatal，权限/沙箱修好之后）。
 * 看门狗按 watchdogIntervalMs 复查，符合条件就 stop + start。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getPluginHandle } from '../lib/index.js'
import { startFakeQQServer } from './helpers/fake-qq-server.js'
import { startFakeNapCatServer } from './helpers/fake-napcat-server.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

/** 轮询等待条件成立（默认 3s 上限）。 */
async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(stepMs)
  }
  return predicate()
}

async function boot({ server, services = {}, pluginConfig = {}, transportDeps = {} }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-watchdog-'))
  const agents = createFakeAgents()
  const ctx = createFakeCtx({
    services: {
      agents,
      ...services,
      dshQqTransportDeps: {
        socketFactory: server.socketFactory,
        apiBase: server.apiBase,
        tokenUrl: server.tokenUrl,
        backoffMs: [10],
        ...transportDeps,
      },
    },
  })
  await apply(ctx, {
    transport: 'qqbot',
    autoConnect: true,
    dataDir: dir,
    watchdogIntervalMs: 200,
    ...pluginConfig,
  })
  return { plugin: getPluginHandle(ctx), ctx, dir }
}

const envBackup = () => ({ id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET })
const envRestore = saved => {
  if (saved.id === undefined) delete process.env.QQ_APP_ID
  else process.env.QQ_APP_ID = saved.id
  if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
  else process.env.QQ_CLIENT_SECRET = saved.secret
}

test('看门狗：启动期凭据文档尚未加载完 → 自动连上（真机：重启后必须手动开关插件）', async t => {
  const server = await startFakeQQServer({ heartbeatIntervalMs: 200 })
  const saved = envBackup()
  delete process.env.QQ_APP_ID
  delete process.env.QQ_CLIENT_SECRET
  // credentials 服务已发布但值为空（模拟 credentials-local 的 loadInitial 还没跑完）
  let loaded = false
  const credentials = {
    async resolve(ref) {
      if (!loaded) return undefined
      return { value: ref === 'QQ_APP_ID' ? 'app-watchdog' : 'sec-watchdog' }
    },
  }
  const { plugin, ctx } = await boot({ server, services: { credentials } })
  t.after(async () => {
    await ctx.dispose()
    await server.close()
    envRestore(saved)
  })

  assert.equal(await plugin.ready, false, '启动瞬间解析不到凭据')
  assert.equal(plugin.transport.status().phase, 'no-credentials')
  assert.match(String(plugin.store.snapshot().meta.lastStartError), /no-credentials/, '失败原因写盘可诊断')

  loaded = true // 凭据文档加载完成：没有任何事件通知，只能靠看门狗
  const connected = await waitFor(() => plugin.transport.status().connected === true)
  assert.equal(connected, true, '看门狗应在下一拍把 transport 拉起来')
  assert.equal(plugin.transport._credentials().appId, 'app-watchdog')
  assert.equal(plugin.store.snapshot().meta.lastStartError, null, '连上后清掉启动失败诊断')
})

test('看门狗：无凭据时保持安静（不刷日志、不反复 stop/start）', async t => {
  const server = await startFakeQQServer({ heartbeatIntervalMs: 200 })
  const saved = envBackup()
  delete process.env.QQ_APP_ID
  delete process.env.QQ_CLIENT_SECRET
  const { plugin, ctx } = await boot({ server })
  t.after(async () => {
    await ctx.dispose()
    await server.close()
    envRestore(saved)
  })

  assert.equal(await plugin.ready, false)
  await tick(700) // 三个看门狗周期
  assert.equal(plugin.transport.status().phase, 'no-credentials', '仍然未配置凭据')
  assert.equal(server.state.tokenRequests, 0, '不应发出任何连接请求')
})

test('看门狗：重连次数耗尽（disconnected）后服务恢复 → 自动复活', async t => {
  const server = await startFakeQQServer({ heartbeatIntervalMs: 200 })
  const saved = envBackup()
  process.env.QQ_APP_ID = 'app-watchdog-2'
  process.env.QQ_CLIENT_SECRET = 'sec-watchdog-2'
  const { plugin, ctx } = await boot({
    server,
    pluginConfig: { watchdogIntervalMs: 200 },
    transportDeps: { maxReconnectAttempts: 1 },
  })
  t.after(async () => {
    await ctx.dispose()
    await server.close()
    envRestore(saved)
  })

  assert.equal(await plugin.ready, true)
  assert.equal(await waitFor(() => plugin.transport.status().connected === true), true, '首次连接成功')

  // 网关故障 → 掉线 → 重连尝试 1 次（上限 1）→ disconnected（transport 自己到此为止）
  // 看门狗会周期性复活，所以用 10ms 采样确保捕获到 disconnected 这一拍
  server.setRestResponse('/gateway', { status: 500, body: { message: 'boom' } })
  server.dropSocket(1006)
  const phases = new Set()
  await waitFor(() => {
    phases.add(plugin.transport.status().phase)
    return phases.has('disconnected')
  }, 3000, 10)
  assert.equal(phases.has('disconnected'), true, `重连耗尽后进入 disconnected（实测相位：${[...phases].join(',')}）`)

  // 故障恢复：不重启 DSH、不动插件，看门狗应自己把连接拉回来
  server.setRestResponse('/gateway', { status: 200, body: { url: server.wsUrl } })
  const revived = await waitFor(() => plugin.transport.status().connected === true, 4000)
  assert.equal(revived, true, '看门狗应复活已耗尽的 transport')
})

test('看门狗：OneBot 缺 wsUrl 时不空转（hasCredentials seam，与官方 AppID/Secret 无关）', async t => {
  const server = await startFakeQQServer({ heartbeatIntervalMs: 200 })
  const saved = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  // 官方凭据是齐的：若看门狗只看 QQ_APP_ID/SECRET，就会误以为「可以复活」而每拍空转
  process.env.QQ_APP_ID = 'app-x'
  process.env.QQ_CLIENT_SECRET = 'secret-x'
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-watchdog-onebot-'))
  const logger = createLogger()
  const ctx = createFakeCtx({
    services: { agents: createFakeAgents(), dshQqTransportDeps: { socketFactory: server.socketFactory, apiBase: server.apiBase, tokenUrl: server.tokenUrl } },
    logger,
  })
  t.after(async () => {
    await ctx.dispose()
    await server.close()
    if (saved.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = saved.id
    if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = saved.secret
  })
  await apply(ctx, { transport: 'onebot', autoConnect: true, dataDir: dir, watchdogIntervalMs: 100 })
  const plugin = getPluginHandle(ctx)
  assert.equal(await plugin.ready, false)
  await tick(500) // 五个看门狗周期

  assert.equal(plugin.transport.status().phase, 'no-credentials')
  assert.equal(plugin.transport.hasCredentials(), false)
  assert.equal(
    logger.entries.info.some(line => line.includes('看门狗发现未连接')),
    false,
    '配置缺失属于静态问题：看门狗必须保持安静，等用户改配置/重载插件',
  )
})

test('回归：transport 内部自愈后，watchdog 必须清掉陈旧的 lastStartError', async t => {
  // 真机 2026-09-28：NapCat 掉线时首次 start 失败写下「握手超时」，之后 transport 用**内部退避**
  // 自己连上了（这步不经过 connectOnce）——于是 WS 连接数已是 1，store.meta 里却还留着旧错误。
  // 排查手册第一条就是看这个字段，陈旧值会直接把人带偏。
  const server = await startFakeNapCatServer({ heartbeatIntervalMs: 500 })
  let failProbe = true
  server.setResponder(({ action }) =>
    failProbe && action === 'get_login_info' ? { status: 'failed', retcode: 100, message: '探测失败' } : null,
  )
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-watchdog-heal-'))
  const agents = createFakeAgents()
  const ctx = createFakeCtx({
    services: { agents, dshQqTransportDeps: { backoffMs: [10] } },
  })
  await apply(ctx, {
    transport: 'onebot',
    autoConnect: true,
    dataDir: dir,
    watchdogIntervalMs: 100,
    onebot: { wsUrl: server.wsUrl, sendRateLimitMs: 0 },
  })
  const plugin = getPluginHandle(ctx)
  t.after(async () => {
    await ctx.dispose()
    await server.close()
  })

  assert.equal(await plugin.ready, false, '首次握手失败应如实返回 false')
  const failed = await waitFor(() => plugin.store.snapshot().meta.lastStartError !== null)
  assert.equal(failed, true, '失败原因必须写盘（否则真机无从排查）')
  assert.match(plugin.store.snapshot().meta.lastStartError, /get_login_info|100/)

  // 故障消失：transport 靠自己的退避重连连上（不经过 connectOnce）
  failProbe = false
  assert.equal(await waitFor(() => plugin.transport.status().connected === true), true, 'transport 应自愈')

  // 看门狗下一拍发现「已连接」，把陈旧诊断清掉
  const cleared = await waitFor(() => plugin.store.snapshot().meta.lastStartError === null)
  assert.equal(cleared, true, '连上后陈旧诊断必须被清掉（诊断字段不能撒谎）')
})
