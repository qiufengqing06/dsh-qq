/**
 * 共享 HTTP 工具：脱敏一致性 + 媒体下载（超时/大小/错误分类）。
 * 这些用例存在的意义：官方线与个人线的旧实现已经漂移过一次（一边有超时一边没有）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { downloadHttp, redactSecrets, redactUrl, withTimeout } from '../lib/http.js'

/** 固定解析到公网地址：测试不依赖本机 DNS（有的环境会把 .invalid 劫持到保留网段）。 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('redactSecrets：client_secret / token 头 / access_token 查询参数都遮蔽', () => {
  assert.equal(redactSecrets('client_secret=abc123&x=1'), 'client_secret=***&x=1')
  assert.equal(redactSecrets('Authorization: QQBot abc.def'), 'Authorization: QQBot ***')
  assert.equal(redactSecrets('Authorization: Bearer xyz-123'), 'Authorization: Bearer ***')
  assert.equal(redactSecrets('ws://h/ws?access_token=secret&v=2'), 'ws://h/ws?access_token=***&v=2')
})

test('redactUrl：userinfo（代理密码）与 token 参数遮蔽', () => {
  assert.equal(redactUrl('http://user:pass@proxy.local:8080'), 'http://***@proxy.local:8080')
  assert.equal(redactUrl('ws://127.0.0.1:3001?s=1&token=abc#frag'), 'ws://127.0.0.1:3001?s=1&token=***#frag')
})

test('withTimeout：外部 signal 与超时合并（任一触发都 abort）', async () => {
  const external = new AbortController()
  const signal = withTimeout(external.signal, 1000)
  assert.equal(signal.aborted, false)
  external.abort()
  assert.equal(signal.aborted, true, '外部取消应传导')
})

test('downloadHttp：成功返回数据与类型；超限/HTTP 错误分类正确', async () => {
  const okFetch = async () => new Response(Buffer.from('abcd'), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '4' } })
  const ok = await downloadHttp({ url: 'https://x.invalid/a.png', maxBytes: 10, lookup: publicLookup, fetchImpl: okFetch })
  assert.equal(ok.ok, true)
  assert.equal(ok.bytes, 4)
  assert.equal(ok.contentType, 'image/png')

  const declaredTooBig = await downloadHttp({
    url: 'https://x.invalid/big',
    maxBytes: 2,
    lookup: publicLookup, fetchImpl: async () => new Response(Buffer.from('abcd'), { status: 200, headers: { 'content-length': '4' } }),
  })
  assert.equal(declaredTooBig.ok, false)
  assert.match(declaredTooBig.error, /超过上限/)

  const tooBig = await downloadHttp({
    url: 'https://x.invalid/big2',
    maxBytes: 2,
    lookup: publicLookup, fetchImpl: async () => new Response(Buffer.from('abcd'), { status: 200 }),
  })
  assert.equal(tooBig.ok, false, '没有 content-length 也要在读取后检查大小')

  const notFound = await downloadHttp({ url: 'https://x.invalid/404', maxBytes: 10, lookup: publicLookup, fetchImpl: async () => new Response('nope', { status: 404 }) })
  assert.equal(notFound.ok, false)
  assert.equal(notFound.status, 404)
  assert.notEqual(notFound.retryable, true, '404 重试没意义')
})

test('downloadHttp：没有 content-length 的大响应流式读取，超限立刻停止', async () => {
  let pulls = 0
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1
      if (pulls > 100) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(10))
    },
  })
  const result = await downloadHttp({
    url: 'https://x.invalid/stream',
    maxBytes: 25,
    lookup: publicLookup,
    fetchImpl: async () => new Response(stream, { status: 200 }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /超过上限/)
  assert.ok(pulls <= 5, `超限后应停止拉取（实际拉了 ${pulls} 次）`)
})

test('媒体 URL 闸门：私网/回环默认拒绝，allowedHosts / allowPrivateHosts 放行', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('ok', { status: 200 })
  }
  const blocked = await downloadHttp({ url: 'http://127.0.0.1:9/secret', maxBytes: 10, fetchImpl })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /私网|回环/)
  assert.equal(calls, 0, '私网 URL 不得发起请求')

  const allowlisted = await downloadHttp({
    url: 'http://127.0.0.1:9/media',
    maxBytes: 10,
    fetchImpl,
    allowedHosts: ['127.0.0.1:9'],
  })
  assert.equal(allowlisted.ok, true)
  assert.equal(calls, 1)

  const privateOn = await downloadHttp({
    url: 'http://localhost:9/media',
    maxBytes: 10,
    fetchImpl,
    allowPrivateHosts: true,
  })
  assert.equal(privateOn.ok, true)
})

test('媒体 URL 闸门：Clash/mihomo fake-IP 段（198.18/15）按公网放行', async () => {
  let calls = 0
  const result = await downloadHttp({
    url: 'https://cdn.example/photo.jpg',
    maxBytes: 10,
    fetchImpl: async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    },
    // Clash 的 fake-IP DNS：域名返回 198.18.x.x，由代理转真实 CDN
    lookup: async () => [{ address: '198.18.1.10', family: 4 }],
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
})

test('媒体 URL 闸门：DNS 解析到私网也拒绝，重定向到私网不会继续拉取', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('ok', { status: 200 })
  }
  const privateDns = await downloadHttp({
    url: 'https://private.example/x',
    maxBytes: 10,
    fetchImpl,
    lookup: async () => [{ address: '10.0.0.5', family: 4 }],
  })
  assert.equal(privateDns.ok, false)
  assert.match(privateDns.error, /私网/)
  assert.equal(calls, 0)

  const redirectFetch = async () => {
    calls += 1
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } })
  }
  calls = 0
  const redirected = await downloadHttp({
    url: 'https://public.example/x',
    maxBytes: 10,
    fetchImpl: redirectFetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  })
  assert.equal(redirected.ok, false)
  assert.match(redirected.error, /私网|回环/)
  assert.equal(calls, 1, '重定向目标被拒绝后不得再发请求')
})

test('媒体重定向：跨源剥离 Authorization，超过上限如实失败', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, authorization: init?.headers?.Authorization ?? init?.headers?.authorization ?? '' })
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/final' } })
    return new Response('ok', { status: 200 })
  }
  const result = await downloadHttp({
    url: 'https://api.example/start',
    maxBytes: 10,
    fetchImpl,
    headers: { Authorization: 'QQBot secret' },
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    maxRedirects: 2,
  })
  assert.equal(result.ok, true)
  assert.equal(seen[0].authorization, 'QQBot secret')
  assert.equal(seen[1].authorization, '', '跨源重定向必须剥离鉴权头')

  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://api.example/again' } })
  const tooMany = await downloadHttp({
    url: 'https://api.example/start',
    maxBytes: 10,
    fetchImpl: loop,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    maxRedirects: 1,
  })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error, /重定向次数/)
})

test('downloadHttp：服务器不响应时超时失败（retryable）', async () => {
  // 模拟「连接建立但永不返回数据」：fetch 永不 resolve，只响应 abort
  const hangingFetch = (url, options) => new Promise((resolve, reject) => {
    const signal = options?.signal
    if (signal === undefined) return
    if (signal.aborted) return reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true })
  })
  // AbortSignal.timeout 的定时器是 unref 的：测试进程没有其它活动时会被提前判定「排队结束」，
  // 用一个 ref 的定时器把事件循环撑住，保证超时真的触发。
  const keepAlive = setTimeout(() => {}, 2000)
  const result = await downloadHttp({ url: 'https://x.invalid/hang', maxBytes: 10, timeoutMs: 40, lookup: publicLookup, fetchImpl: hangingFetch })
  clearTimeout(keepAlive)
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.match(result.error, /媒体下载失败/)
})
