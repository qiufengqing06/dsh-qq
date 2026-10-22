/**
 * 共享 HTTP 工具：脱敏一致性 + 媒体下载（超时/大小/错误分类）。
 * 这些用例存在的意义：官方线与个人线的旧实现已经漂移过一次（一边有超时一边没有）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { downloadHttp, redactSecrets, redactUrl, withTimeout } from '../lib/http.js'

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
  const ok = await downloadHttp({ url: 'https://x.invalid/a.png', maxBytes: 10, fetchImpl: okFetch })
  assert.equal(ok.ok, true)
  assert.equal(ok.bytes, 4)
  assert.equal(ok.contentType, 'image/png')

  const declaredTooBig = await downloadHttp({
    url: 'https://x.invalid/big',
    maxBytes: 2,
    fetchImpl: async () => new Response(Buffer.from('abcd'), { status: 200, headers: { 'content-length': '4' } }),
  })
  assert.equal(declaredTooBig.ok, false)
  assert.match(declaredTooBig.error, /超过上限/)

  const tooBig = await downloadHttp({
    url: 'https://x.invalid/big2',
    maxBytes: 2,
    fetchImpl: async () => new Response(Buffer.from('abcd'), { status: 200 }),
  })
  assert.equal(tooBig.ok, false, '没有 content-length 也要在读取后检查大小')

  const notFound = await downloadHttp({ url: 'https://x.invalid/404', maxBytes: 10, fetchImpl: async () => new Response('nope', { status: 404 }) })
  assert.equal(notFound.ok, false)
  assert.equal(notFound.status, 404)
  assert.notEqual(notFound.retryable, true, '404 重试没意义')
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
  const result = await downloadHttp({ url: 'https://x.invalid/hang', maxBytes: 10, timeoutMs: 40, fetchImpl: hangingFetch })
  clearTimeout(keepAlive)
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.match(result.error, /媒体下载失败/)
})
