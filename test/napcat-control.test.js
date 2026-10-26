/**
 * NapCat 控制器验收：状态探测、二维码读取、启停动作白名单。
 *
 * 全部走注入的假实现（probePort / stat / readFile / execFile），不碰真实进程与网络。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { NAPCAT_ACTIONS, createNapcatControl } from '../lib/onebot/napcat-control.js'
import { createLogger } from './helpers/fake-ctx.js'

function makeConfig(napcat = {}) {
  return resolveConfig({ transport: 'onebot', autoConnect: false, napcat })
}

/** 可控的探针：port → bool。 */
function makeProbe(open) {
  const calls = []
  const probe = async port => {
    calls.push(port)
    return open.includes(port)
  }
  probe.calls = calls
  return probe
}

/** 可控的 stat：返回 mtime 或抛错。 */
function makeStat(mtimeMs) {
  return async () => {
    if (mtimeMs === null) {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    }
    return { mtimeMs }
  }
}

test('状态：都不可达 → 宿主未运行、未登录、二维码不可用', async () => {
  const control = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/qr.png', ctlScript: '/tmp/ctl.sh' }),
    logger: createLogger(),
    override: { probePort: makeProbe([]), stat: makeStat(null), now: () => 1_000_000 },
  })
  const status = await control.status()
  assert.equal(status.running, false)
  assert.equal(status.loggedIn, false)
  assert.equal(status.onebotListening, false)
  assert.equal(status.webuiReachable, false)
  assert.equal(status.qr.available, false)
  assert.equal(status.ctlConfigured, true)
})

test('状态：3001 监听 = 已登录；6099 监听 = 宿主在跑', async () => {
  const probe = makeProbe([3001, 6099])
  const control = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/qr.png' }),
    override: { probePort: probe, stat: makeStat(null) },
  })
  const status = await control.status()
  assert.equal(status.loggedIn, true)
  assert.equal(status.running, true)
  assert.deepEqual(probe.calls.sort((a, b) => a - b), [3001, 6099])
})

test('WebUI 端口按配置推断：配置 URL / webui.json 自定义端口都能探到', async () => {
  const probeConfigured = makeProbe([3001])
  const configured = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/napcat/cache/qrcode.png', webuiUrl: 'http://127.0.0.1:7000' }),
    override: {
      probePort: probeConfigured,
      stat: makeStat(null),
      readFile: async path => (path.endsWith('/config/webui.json') ? JSON.stringify({ token: '', port: 6099 }) : null),
    },
  })
  await configured.status()
  assert.deepEqual(probeConfigured.calls.sort((a, b) => a - b), [3001, 7000], '应探测配置里的 7000，而不是写死的 6099')

  const probeJson = makeProbe([3001])
  const fromJson = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/napcat/cache/qrcode.png' }),
    override: {
      probePort: probeJson,
      stat: makeStat(null),
      readFile: async path => (path.endsWith('/config/webui.json') ? JSON.stringify({ token: '', port: 7001 }) : null),
    },
  })
  await fromJson.status()
  assert.deepEqual(probeJson.calls.sort((a, b) => a - b), [3001, 7001], '没有配置 URL 时用 webui.json 的端口')
})

test('二维码：文件存在时给出生成时间与年龄，过期标记 qrStale', async () => {
  const now = 1_000_000
  const control = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/qr.png' }),
    override: { probePort: makeProbe([]), stat: makeStat(now - 5 * 60 * 1000), now: () => now },
  })
  const status = await control.status()
  assert.equal(status.qr.available, true)
  assert.equal(status.qr.updatedAt, now - 300_000)
  assert.equal(control.qrStale(status.qr), true, '超过 3 分钟应提示可能过期')
  const fresh = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/qr.png' }),
    override: { probePort: makeProbe([]), stat: makeStat(now - 10_000), now: () => now },
  })
  assert.equal(fresh.qrStale((await fresh.status()).qr), false)
})

test('二维码：未配置路径时 available=false，二维码图片读取返回 null', async () => {
  const control = createNapcatControl({ config: makeConfig(), override: { probePort: makeProbe([]) } })
  const status = await control.status()
  assert.equal(status.qr.configured, false)
  assert.equal(status.qr.available, false)
  assert.equal(await control.qrImage(), null)
})

test('二维码：读取配置的 PNG 字节', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const control = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/qr.png' }),
    override: { readFile: async path => (path === '/tmp/qr.png' ? bytes : null), probePort: makeProbe([]) },
  })
  assert.deepEqual(await control.qrImage(), bytes)
})

test('动作：白名单内的 start/stop/restart 执行配置脚本；其它动作拒绝', async () => {
  const calls = []
  const control = createNapcatControl({
    config: makeConfig({ ctlScript: '/tmp/ctl.sh' }),
    logger: createLogger(),
    override: {
      probePort: makeProbe([]),
      execFile: async (file, args, options) => {
        calls.push({ file, args, timeout: options?.timeout })
        return { stdout: 'ok', stderr: '' }
      },
    },
  })
  const started = await control.run('start')
  assert.equal(started.ok, true)
  assert.match(started.output, /ok/)
  assert.deepEqual(calls[0], { file: 'bash', args: ['/tmp/ctl.sh', 'start'], timeout: 90_000 })
  assert.equal((await control.run('restart')).ok, true)
  const bad = await control.run('rm -rf /')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不支持的动作/)
  assert.deepEqual(calls.map(call => call.args[1]), ['start', 'restart'], '非法动作不得执行')
  assert.deepEqual(NAPCAT_ACTIONS, ['start', 'stop', 'restart'])
})

test('动作：未配置脚本时如实报错；脚本失败时带上输出', async () => {
  const unconfigured = createNapcatControl({ config: makeConfig(), override: { probePort: makeProbe([]) } })
  const noScript = await unconfigured.run('start')
  assert.equal(noScript.ok, false)
  assert.match(noScript.error, /ctlScript/)

  const failing = createNapcatControl({
    config: makeConfig({ ctlScript: '/tmp/ctl.sh' }),
    override: {
      probePort: makeProbe([]),
      execFile: async () => {
        const error = new Error('Command failed')
        error.stdout = 'partial out'
        error.stderr = 'boom'
        throw error
      },
    },
  })
  const failed = await failing.run('start')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /Command failed/)
  assert.match(failed.output, /boom/)
})

test('enabled=false 时状态直接返回关闭态（不探端口）', async () => {
  const probe = makeProbe([3001])
  const control = createNapcatControl({ config: makeConfig({ enabled: false }), override: { probePort: probe } })
  const status = await control.status()
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  assert.deepEqual(probe.calls, [])
})

// ── WebUI 链接：从浏览器点开就能用（Windows/WSL 地址 + token）──

test('buildWebuiLinks：回环地址改成 localhost 优先，并带上 token', async () => {
  const { buildWebuiLinks } = await import('../lib/onebot/napcat-control.js')
  const links = buildWebuiLinks({ configuredUrl: 'http://127.0.0.1:6099', token: 'aa9252c9dd1d', addresses: ['172.22.92.154'] })
  assert.equal(links.preferred, 'http://localhost:6099/webui?token=aa9252c9dd1d')
  const urls = links.alternates.map(entry => entry.url)
  assert.ok(urls.includes('http://172.22.92.154:6099/webui?token=aa9252c9dd1d'), 'WSL IP 备选')
  assert.ok(urls.includes('http://127.0.0.1:6099/webui?token=aa9252c9dd1d'), '127.0.0.1 备选（WSL 内可用）')
  assert.equal(new Set(urls).size, urls.length, '备选不重复')
})

test('buildWebuiLinks：已有 token 不重复追加；非回环地址保持首选', async () => {
  const { buildWebuiLinks } = await import('../lib/onebot/napcat-control.js')
  const keep = buildWebuiLinks({ configuredUrl: 'http://localhost:6099/webui?token=abc', token: 'zzz' })
  assert.equal(keep.preferred, 'http://localhost:6099/webui?token=abc')
  const remote = buildWebuiLinks({ configuredUrl: 'http://192.168.1.9:6099', token: 't1', addresses: ['172.22.92.154'] })
  assert.equal(remote.preferred, 'http://192.168.1.9:6099/webui?token=t1')
  assert.equal(remote.alternates[0].url, 'http://localhost:6099/webui?token=t1')
})

test('状态：GET state 的 WebUI 链接不带 token；token 走 webuiLinksWithToken()', async () => {
  const control = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/napcat/cache/qrcode.png', webuiUrl: 'http://127.0.0.1:6099' }),
    override: {
      probePort: makeProbe([3001, 6099]),
      stat: makeStat(null),
      readFile: async path => {
        if (path.endsWith('/config/webui.json')) return JSON.stringify({ token: 'tok123456789', port: 6099 })
        return null
      },
    },
  })
  const status = await control.status()
  // M2：GET /api/state 不回显 admin token
  assert.equal(status.webuiUrl, 'http://localhost:6099/webui')
  assert.equal(JSON.stringify(status).includes('tok123456789'), false, '状态里不得出现 token')
  assert.equal(status.webuiTokenConfigured, true)
  // 需要 token 时走专门方法（页面用 POST 端点调用）
  const tokenized = await control.webuiLinksWithToken()
  assert.equal(tokenized.preferred, 'http://localhost:6099/webui?token=tok123456789')
})

test('状态：webui.json 缺失时不带 token，仍给出 localhost 链接', async () => {
  const control = createNapcatControl({
    config: makeConfig({ qrFile: '/tmp/napcat/cache/qrcode.png' }),
    override: { probePort: makeProbe([]), stat: makeStat(null), readFile: async () => null },
  })
  const status = await control.status()
  assert.equal(status.webuiUrl, 'http://localhost:6099/webui')
  assert.equal(status.webuiUrl.includes('token='), false)
})
