import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStickerTools } from '../lib/sticker-tools.js'

const chatKey = 'qqbot:account:group:100'
const exec = { agent: { session: { id: 'session-1' } } }

test('list_stickers 的实际模型渲染含完整描述、用途与可用原因', async () => {
  const desc = '小鲸鱼捧着饭碗，抬眉看向对方，图中文字是“摸头另算”。'.repeat(6)
  let listed
  const [list] = createStickerTools({
    store: {
      load: async () => {},
      list: (key, options) => {
        listed = { key, options }
        return [
          { id: 'available-id', state: 'library', tags: ['调侃'], desc, sourceText: '白饭梗', preferred: true, available: true, reason: '' },
          { id: 'used-id', state: 'candidate', tags: ['得意'], desc: '托腮笑', sourceText: '', available: false, reason: '这张图最近发过，换一张' },
        ]
      },
    },
    chatKeyOf: () => chatKey,
    modeOf: () => 'chat',
    turnIdOf: () => 'turn-42',
  })
  const value = await list.execute({ query: '调侃' }, exec)
  const rendered = list.output.render({}, value).map(part => part.text).join('\n')
  assert.equal(listed.key, chatKey)
  assert.equal(listed.options.turnId, 'turn-42')
  assert.ok(rendered.includes(desc), 'render 不能只输出标签而丢掉视觉描述')
  assert.match(rendered, /可发送/)
  assert.match(rendered, /用途标签：调侃/)
  assert.match(rendered, /available-id · 收藏 · 人设精选 · 可发送/)
  assert.doesNotMatch(rendered.split('\n').find(line => line.includes('used-id')), /人设精选/)
  assert.match(rendered, /暂不可发：这张图最近发过/)
})

test('send_sticker 接入共享动作队列，不绕过 dispatchReply 独立发送', async () => {
  let dispatched
  const tools = createStickerTools({
    store: { send: async () => assert.fail('不可绕过共享发送队列') },
    chatKeyOf: () => chatKey,
    modeOf: () => 'chat',
    dispatchReply: async (actions, context) => {
      dispatched = { actions, context }
      return { ok: true, message: '已按顺序发送。', id: 'image-1' }
    },
  })
  const result = await tools.find(tool => tool.name === 'send_sticker').execute({ id: 'image-1' }, exec)
  assert.deepEqual(dispatched.actions, [{ type: 'sticker', id: 'image-1', query: '', tag: '' }])
  assert.equal(dispatched.context, exec)
  assert.deepEqual(result, { ok: true, message: '已按顺序发送。', id: 'image-1' })
})

test('共享发送队列的取消结果如实返回；关闭表情不提交动作', async () => {
  let enabled = true
  let calls = 0
  const tools = createStickerTools({
    store: {},
    chatKeyOf: () => chatKey,
    modeOf: () => 'chat',
    chatPreference: () => ({ stickers: enabled }),
    dispatchReply: async () => { calls += 1; return { ok: false, error: '本轮已取消' } },
  })
  const send = tools.find(tool => tool.name === 'send_sticker')
  assert.deepEqual(await send.execute({ id: 'image-1' }, exec), { ok: false, message: '本轮已取消' })
  enabled = false
  assert.match((await send.execute({ id: 'image-1' }, exec)).message, /关闭表情包/)
  assert.equal(calls, 1)
})
