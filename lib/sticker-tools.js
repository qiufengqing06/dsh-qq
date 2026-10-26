/** 表情包工具：list_stickers / send_sticker。 */
import { parseChatKey } from './transport.js'

function toolError(message) {
  return { ok: false, message }
}

export function createStickerTools({ store, transport, chatKeyOf, modeOf, chatPreference = () => ({ stickers: true }), turnIdOf = () => '', dispatchReply = null }) {
  return [
    {
      name: 'list_stickers',
      description:
        '列出当前 QQ 对话的表情包（含待整理候选），按中文用途标签、画面描述或来源文本搜索。只在聊天模式使用；' +
        '返回 id、画面描述、用途标签、人设精选标记和当前可发送状态。优先选贴切的精选图，也可使用普通图库；先看描述再选，跳过暂不可用的图，没有贴切候选就不发。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '中文用途、画面描述或来源文本关键词，例如嫌弃、摸头、吃饭；兼容 happy 等旧英文标签' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'message'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      async execute(args, exec) {
        const sessionId = String(exec?.agent?.session?.id ?? '')
        const chatKey = sessionId === '' ? null : chatKeyOf(sessionId)
        if (chatKey === null) return toolError('list_stickers 只能在 QQ 对话里使用。')
        if (modeOf(chatKey) !== 'chat') return toolError('表情包只在聊天模式可用。')
        await store.load()
        const items = store.list(chatKey, { query: String(args?.query ?? ''), limit: Number(args?.limit) || 20, turnId: turnIdOf(exec) })
        if (items.length === 0) return { ok: true, message: '当前对话没有匹配的表情包。', items: [] }
        const lines = items.map(item => [
          `- ${item.id} · ${item.state === 'library' ? '收藏' : '候选'}${item.preferred ? ' · 人设精选' : ''} · ${item.available === false ? `暂不可发：${item.reason}` : '可发送'}`,
          `  画面描述：${item.desc || '暂无描述；不能据此猜测画面内容'}`,
          `  用途标签：${item.tags.join('/') || '未标注'}`,
          ...(item.sourceText ? [`  来源文本：${item.sourceText}`] : []),
        ].join('\n'))
        return { ok: true, message: ['当前表情候选（看描述选择可发送的图）：', ...lines].join('\n'), items }
      },
    },
    {
      name: 'send_sticker',
      description:
        '从当前对话的表情包图库挑一张发送，遵守每轮数量、冷却和日额度。仅在聊天模式、图库启用时可用；' +
        '真实冲突/严肃求助优先文字，轻松互怼按上下文选择；先查看候选描述，没有贴切候选就不发。可用 id 精确发送，或 query 按用途/画面描述搜索。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '精确的表情 id' },
          query: { type: 'string', description: '用途标签、画面描述或来源文本关键词' },
          tag: { type: 'string', description: '中文用途标签，如开心、嫌弃、调侃、得意、安慰、晚安；兼容 happy/angry/sad/shy/confused/daily' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['ok', 'message'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      async execute(args, exec) {
        const sessionId = String(exec?.agent?.session?.id ?? '')
        const chatKey = sessionId === '' ? null : chatKeyOf(sessionId)
        if (chatKey === null) return toolError('send_sticker 只能在 QQ 对话里使用。')
        if (modeOf(chatKey) !== 'chat') return toolError('表情包只在聊天模式可用。')
        if (chatPreference(chatKey).stickers === false) return toolError('本群已关闭表情包（/qq-pref stickers on 可恢复）。')
        const selector = { id: String(args?.id ?? ''), query: String(args?.query ?? ''), tag: String(args?.tag ?? '') }
        if (typeof dispatchReply === 'function') {
          const result = await dispatchReply([{ type: 'sticker', ...selector }], exec)
          if (result?.ok !== true) return toolError(result?.message ?? result?.error ?? '发送失败')
          return { ok: true, message: result.message ?? '表情包已发送。', ...(result.id ? { id: result.id } : {}) }
        }
        const route = parseChatKey(chatKey)
        const turnId = turnIdOf(exec)
        const result = await store.send({
          chatKey,
          target: route.target,
          transport,
          route: { transportKind: route.transportKind, accountId: route.accountId },
          mode: modeOf(chatKey),
          ...selector,
          turnId,
          isValid: () => chatKeyOf(sessionId) === chatKey && modeOf(chatKey) === 'chat'
            && chatPreference(chatKey).stickers !== false && turnIdOf(exec) === turnId,
        })
        if (result.ok !== true) return toolError(result.error ?? '发送失败')
        return { ok: true, message: '表情包已发送。', id: result.id }
      },
    },
  ]
}

export default createStickerTools
