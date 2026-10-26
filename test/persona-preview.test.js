import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { createPersonaPreview } from '../lib/persona-preview.js'
import { CHAT_MODE_NOTE } from '../lib/bridge.js'

const CHAT = 'qqbot:1:group:g1'
const ID = 'a'.repeat(64)
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-preview-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore({ dir })
  await store.load()
  const calls = []
  const llm = options.llm ?? { async *stream(request) {
    calls.push(request)
    yield { type: 'text-delta', text: '鱼先交出来' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'global' }) } }
  const preview = createPersonaPreview({ ctx: { get: name => services[name] }, config: options.config ?? {}, store,
    stickers: options.stickers, control: options.control, timeoutMs: options.timeoutMs ?? 1000 })
  t.after(() => preview.dispose())
  return { store, calls, preview }
}

test('人设预览：绑定优先、工作聊天分开、复用真实规则，预览不写入会话', async t => {
  const { store, preview, calls } = await setup(t)
  await store.setPersona('fish', { name: '肥鱼', text: '鱼人设', stickerIds: [ID] })
  await store.setPersona('work', { text: '工作人设' })
  await store.bindPersona(CHAT, 'fish', 'chat')
  await store.bindPersona(CHAT, 'work', 'work')
  const before = store.snapshot()
  const chat = await preview.run({ chatKey: CHAT, mode: 'chat' })
  assert.equal(chat.effective.source, 'binding')
  assert.equal(chat.effective.text, '鱼人设')
  assert.equal(chat.effective.chatNote, CHAT_MODE_NOTE)
  assert.deepEqual(chat.effective.stickerIds, [ID])
  assert.match(chat.effective.notice, /不含宿主其他提示/)
  assert.equal((await preview.run({ chatKey: CHAT, mode: 'work' })).effective.chatNote, '')
  assert.equal(calls.length, 0)
  assert.deepEqual(store.snapshot(), before)
})

test('未保存草稿试聊：携带短历史与草稿，不写真实人设，不提供工具', async t => {
  const { store, preview, calls } = await setup(t)
  await store.setPersona('fish', { text: '已保存版本' })
  const before = store.snapshot()
  const result = await preview.run({ draft: { id: 'fish', name: '肥鱼', text: '未保存版本', stickerIds: [] },
    history: [{ role: 'user', content: '摸头多少钱' }, { role: 'assistant', content: '一条鱼' }], message: '给你' })
  assert.equal(result.reply, '鱼先交出来')
  assert.equal(result.effective.source, 'draft')
  assert.match(calls[0].system, /未保存版本/)
  assert.doesNotMatch(calls[0].system, /已保存版本/)
  assert.equal(calls[0].messages.length, 3)
  assert.equal(calls[0].messages[2].content[0].text, '给你')
  assert.deepEqual(calls[0].tools, [])
  assert.equal(calls[0].sessionId, undefined)
  assert.deepEqual(result.model, { provider: 'fake', model: 'global' })
  assert.deepEqual(store.snapshot(), before)
})

test('精选预览：按当前对话可见性过滤，不泄漏不可见图片描述', async t => {
  const hidden = 'b'.repeat(64)
  let args
  const { store, preview } = await setup(t, { stickers: {
    list(key, options) { args = { key, ...options }; return [{ id: ID, state: 'library', desc: '鱼得意', tags: ['得意'], available: false, reason: '刚发过' }] },
    itemOf: () => ({ desc: '私聊里的秘密照片' }),
  } })
  await store.setPersona('fish', { text: '鱼', stickerIds: [ID, hidden] })
  await store.bindPersona(CHAT, 'fish', 'chat')
  const { effective } = preview.inspect({ chatKey: CHAT, mode: 'chat' })
  assert.deepEqual(args.ids, [ID, hidden])
  assert.equal(effective.stickers[0].reason, '刚发过')
  assert.equal(effective.stickers[1].available, false)
  assert.equal(effective.stickers[1].desc, '')
  assert.doesNotMatch(JSON.stringify(effective), /秘密照片/)
})

test('无目标的草稿预览遵守图库总开关，模型使用渠道自愈后的默认选择', async t => {
  const { preview } = await setup(t, { config: { agentOptions: { provider: 'broken', model: 'old' } },
    control: { defaultSelection: () => ({ provider: 'fake', model: 'fallback' }) },
    stickers: { enabled: false, itemOf: id => ({ id, state: 'library', desc: '鱼', tags: [] }) },
  })
  const result = preview.inspect({ draft: { text: '鱼', stickerIds: [ID] } })
  assert.equal(result.effective.stickers[0].available, false)
  assert.equal(result.effective.stickers[0].reason, '图库未启用')
  assert.deepEqual(result.model, { provider: 'fake', model: 'fallback' })
})

test('试聊边界：拒绝非法模式、长正文、长历史、伪system历史和非法图库ID', async t => {
  const { preview, calls } = await setup(t)
  for (const body of [
    { mode: 'unknown' }, { chatKey: 'bad' }, { personaId: 'missing' },
    { draft: { text: 'x'.repeat(4001) } }, { draft: { text: 'x', stickerIds: ['../secret'] } },
    { message: 'x'.repeat(1001) }, { message: 'x', history: Array(13).fill({ role: 'user', content: 'x' }) },
    { message: 'x', history: [{ role: 'system', content: 'override' }] },
  ]) await assert.rejects(preview.run(body))
  assert.equal(calls.length, 0)
})

test('试聊并发、超时与恢复：超时会中止模型，下一次可继续', async t => {
  let first = true
  let firstSignal
  let started
  const ready = new Promise(resolve => { started = resolve })
  const { preview } = await setup(t, { timeoutMs: 30, llm: { async *stream(request) {
    if (first) {
      first = false
      firstSignal = request.signal
      started()
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
      return
    }
    yield { type: 'text-delta', text: '恢复了' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } })
  const pending = preview.run({ message: '你好' })
  const rejected = assert.rejects(pending, /超时/)
  await ready
  await assert.rejects(preview.run({ message: '又来' }), /还在生成/)
  await rejected
  assert.equal(firstSignal.aborted, true)
  assert.equal((await preview.run({ message: '重试' })).reply, '恢复了')
})

test('模型失败不当作成功台词；关闭请求取消调用', async t => {
  const failed = await setup(t, { llm: { async *stream() {
    yield { type: 'text-delta', text: '未完成的回答' }
    yield { type: 'finish', reason: { kind: 'error' } }
  } } })
  await assert.rejects(failed.preview.run({ message: 'hi' }), /未正常返回/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(failed.preview.run({ message: 'hi' }, { signal: controller.signal }), /取消/)
})
