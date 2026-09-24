import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_STT_MODEL, STT_API_KEY_REF, resolveSttApiKey, transcribeAudio } from '../lib/stt.js'
import { createFakeCtx } from './helpers/fake-ctx.js'

/** 假 STT 端点（OpenAI 兼容 /audio/transcriptions）。 */
function createFakeStt({ status = 200, text = '你好世界', body = null } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (body !== null) {
      return { ok: status < 400, status, json: async () => body }
    }
    return { ok: status < 400, status, json: async () => ({ text }) }
  }
  return { calls, fetchImpl }
}

const stt = { provider: 'zai', baseUrl: 'https://stt.example.invalid/api/', model: 'glm-asr' }

test('transcribeAudio：POST /audio/transcriptions（multipart + Bearer），返回文本', async () => {
  const fake = createFakeStt({ text: '帮我看看这段语音' })
  const result = await transcribeAudio({
    data: Buffer.from('fake-silk-bytes'),
    fileName: 'voice.silk',
    mime: 'audio/silk',
    stt,
    apiKey: 'key-123',
    fetchImpl: fake.fetchImpl,
  })
  assert.deepEqual(result, { ok: true, text: '帮我看看这段语音' })
  const call = fake.calls[0]
  assert.equal(call.url, 'https://stt.example.invalid/api/audio/transcriptions', 'baseUrl 末尾斜杠应被归一')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.Authorization, 'Bearer key-123')
  assert.ok(call.init.body instanceof FormData, '应使用 multipart 表单')
  assert.equal(call.init.body.get('model'), 'glm-asr')
  const file = call.init.body.get('file')
  assert.ok(file instanceof Blob)
  assert.equal(file.size, Buffer.byteLength('fake-silk-bytes'))
})

test('transcribeAudio：缺端点/缺 key/空音频/HTTP 错误/空文本都如实报错', async () => {
  const fake = createFakeStt()
  const base = { data: Buffer.from('x'), stt, apiKey: 'k', fetchImpl: fake.fetchImpl }

  assert.match((await transcribeAudio({ ...base, stt: { baseUrl: '' } })).error, /未配置 STT 端点/)
  assert.match((await transcribeAudio({ ...base, apiKey: '' })).error, new RegExp(STT_API_KEY_REF))
  assert.match((await transcribeAudio({ ...base, data: Buffer.alloc(0) })).error, /音频字节为空/)

  const failing = createFakeStt({ status: 500, body: { error: 'boom' } })
  assert.match((await transcribeAudio({ ...base, fetchImpl: failing.fetchImpl })).error, /HTTP 500/)

  const empty = createFakeStt({ body: { text: '   ' } })
  assert.match((await transcribeAudio({ ...base, fetchImpl: empty.fetchImpl })).error, /未返回文本/)

  const throwing = async () => {
    throw new Error('network down')
  }
  assert.match((await transcribeAudio({ ...base, fetchImpl: throwing })).error, /STT 请求失败/)
})

test('transcribeAudio：未给 model 时用默认模型', async () => {
  const fake = createFakeStt()
  await transcribeAudio({
    data: Buffer.from('x'),
    stt: { baseUrl: 'https://stt.example.invalid' },
    apiKey: 'k',
    fetchImpl: fake.fetchImpl,
  })
  assert.equal(fake.calls[0].init.body.get('model'), DEFAULT_STT_MODEL)
})

test('resolveSttApiKey：credentials 优先，其次环境变量', async () => {
  const saved = process.env[STT_API_KEY_REF]
  try {
    delete process.env[STT_API_KEY_REF]
    assert.equal(await resolveSttApiKey(createFakeCtx({})), '')
    process.env[STT_API_KEY_REF] = 'env-key'
    assert.equal(await resolveSttApiKey(createFakeCtx({})), 'env-key')

    const credentials = {
      async resolve(ref) {
        return ref === STT_API_KEY_REF ? { value: 'svc-key' } : undefined
      },
    }
    assert.equal(await resolveSttApiKey(createFakeCtx({ services: { credentials } })), 'svc-key')
  } finally {
    if (saved === undefined) delete process.env[STT_API_KEY_REF]
    else process.env[STT_API_KEY_REF] = saved
  }
})
