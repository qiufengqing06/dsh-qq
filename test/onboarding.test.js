import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  BIND_STATUS,
  buildConnectUrl,
  createOnboardingProvider,
  decryptSecret,
  encryptSecret,
  generateBindKey,
} from '../lib/onboarding.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'bind-secret.json'), 'utf8'))

/** 假 q.qq.com portal：create_bind_task / poll_bind_result。 */
async function startFakePortal({ statuses = [BIND_STATUS.COMPLETED], retcode = 0 } = {}) {
  const state = { createCalls: [], pollCalls: [], headers: [], taskSeq: 0, pollSeq: 0 }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      const body = raw === '' ? null : JSON.parse(raw)
      state.headers.push({ path: req.url, headers: req.headers })
      const send = payload => {
        const text = JSON.stringify(payload)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(text)
      }
      if (req.url === '/lite/create_bind_task') {
        state.createCalls.push(body)
        state.taskSeq += 1
        if (retcode !== 0) return send({ retcode, msg: 'boom' })
        return send({ retcode: 0, data: { task_id: `task-${state.taskSeq}` } })
      }
      if (req.url === '/lite/poll_bind_result') {
        state.pollCalls.push(body)
        const status = statuses[Math.min(state.pollSeq, statuses.length - 1)]
        state.pollSeq += 1
        if (status === BIND_STATUS.COMPLETED) {
          const key = state.createCalls.at(-1).key
          return send({
            retcode: 0,
            data: {
              status,
              bot_appid: 'app-42',
              bot_encrypt_secret: encryptSecret('secret-42', key),
              user_openid: 'openid-owner',
            },
          })
        }
        return send({ retcode: 0, data: { status } })
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    portalHost: `127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('QR URL 与 key 生成', () => {
  const url = buildConnectUrl('task-abc', 'q.qq.com')
  assert.equal(url, 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-abc&_wv=2&source=dsh-qq')
  assert.match(buildConnectUrl('a b', 'sandbox.q.qq.com'), /task_id=a%20b/)
  const key = generateBindKey()
  assert.equal(Buffer.from(key, 'base64').length, 32)
  assert.notEqual(generateBindKey(), key)
})

test('AES-256-GCM：Python 生成的密文（Hermes 布局）Node 能解出', () => {
  assert.equal(decryptSecret(fixture.encryptedBase64, fixture.keyBase64), fixture.plaintext)
  // Node 加密 → Node 解密（布局一致）
  const key = generateBindKey()
  const ciphertext = encryptSecret('往返测试', key)
  assert.equal(decryptSecret(ciphertext, key), '往返测试')
  assert.equal(Buffer.from(ciphertext, 'base64').length, 12 + Buffer.byteLength('往返测试', 'utf8') + 16)
})

test('AES-256-GCM：错误 key / 过短密文 / 篡改都被拒绝', () => {
  const key = generateBindKey()
  const otherKey = generateBindKey()
  const ciphertext = encryptSecret('secret', key)
  assert.throws(() => decryptSecret(ciphertext, otherKey), /Unsupported state|auth/i)
  assert.throws(() => decryptSecret('AAAA', key), /密文长度不足/)
  assert.throws(() => decryptSecret(ciphertext, 'short'), /32 字节/)
  const raw = Buffer.from(ciphertext, 'base64')
  raw[raw.length - 1] ^= 0x01 // 篡改 tag
  assert.throws(() => decryptSecret(raw.toString('base64'), key), /Unsupported state|auth/i)
})

test('begin()：发起绑定任务、带上反爬头、返回可扫码 URL', async () => {
  const portal = await startFakePortal()
  try {
    const provider = createOnboardingProvider({ portalHost: portal.portalHost, baseUrl: portal.baseUrl, pollIntervalMs: 5 })
    const began = await provider.begin()
    assert.equal(began.taskId, 'task-1')
    assert.equal(Buffer.from(began.key, 'base64').length, 32)
    assert.match(began.url, /task-1/)
    assert.deepEqual(portal.state.createCalls[0].key, began.key)
    const headers = portal.state.headers[0].headers
    assert.equal(headers.accept, 'application/json', 'q.qq.com 需要 Accept: application/json')
    assert.match(headers['user-agent'], /dsh-qq/)
  } finally {
    await portal.close()
  }
})

test('wait()：PENDING → COMPLETED，解出 client_secret 与扫码者 openid', async () => {
  const portal = await startFakePortal({ statuses: [BIND_STATUS.PENDING, BIND_STATUS.PENDING, BIND_STATUS.COMPLETED] })
  try {
    const provider = createOnboardingProvider({ portalHost: portal.portalHost, baseUrl: portal.baseUrl, pollIntervalMs: 5 })
    const began = await provider.begin()
    const result = await provider.wait({ taskId: began.taskId, key: began.key, timeout: 2000 })
    assert.deepEqual(result, { appId: 'app-42', clientSecret: 'secret-42', userOpenId: 'openid-owner' })
    assert.equal(portal.state.pollCalls.length, 3)
  } finally {
    await portal.close()
  }
})

test('wait()：二维码过期自动换新（最多 3 次），onRefresh 收到新 URL', async () => {
  const portal = await startFakePortal({
    statuses: [BIND_STATUS.EXPIRED, BIND_STATUS.EXPIRED, BIND_STATUS.PENDING, BIND_STATUS.COMPLETED],
  })
  try {
    const provider = createOnboardingProvider({ portalHost: portal.portalHost, baseUrl: portal.baseUrl, pollIntervalMs: 5, maxRefreshes: 3 })
    const began = await provider.begin()
    const refreshes = []
    const result = await provider.wait({
      taskId: began.taskId,
      key: began.key,
      timeout: 3000,
      onRefresh: info => refreshes.push(info),
    })
    assert.equal(result.appId, 'app-42')
    assert.equal(refreshes.length, 2)
    assert.equal(portal.state.createCalls.length, 3, '两次过期 → 共三次创建任务')
    assert.equal(refreshes[1].taskId, 'task-3')
  } finally {
    await portal.close()
  }
})

test('wait()：超时返回 null；retcode≠0 时 begin 抛错', async () => {
  const portal = await startFakePortal({ statuses: [BIND_STATUS.PENDING] })
  try {
    const provider = createOnboardingProvider({ portalHost: portal.portalHost, baseUrl: portal.baseUrl, pollIntervalMs: 5 })
    const began = await provider.begin()
    const started = Date.now()
    assert.equal(await provider.wait({ taskId: began.taskId, key: began.key, timeout: 40 }), null)
    assert.ok(Date.now() - started < 1000)
  } finally {
    await portal.close()
  }

  const failing = await startFakePortal({ retcode: 1001 })
  try {
    const provider = createOnboardingProvider({ portalHost: failing.portalHost, baseUrl: failing.baseUrl, pollIntervalMs: 5 })
    await assert.rejects(() => provider.begin(), /失败/)
  } finally {
    await failing.close()
  }
})

test('wait()：取消信号中止等待', async () => {
  const portal = await startFakePortal({ statuses: [BIND_STATUS.PENDING] })
  try {
    const provider = createOnboardingProvider({ portalHost: portal.portalHost, baseUrl: portal.baseUrl, pollIntervalMs: 50 })
    const began = await provider.begin()
    const controller = new AbortController()
    const pending = provider.wait({ taskId: began.taskId, key: began.key, timeout: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    assert.equal(await pending, null)
  } finally {
    await portal.close()
  }
})
