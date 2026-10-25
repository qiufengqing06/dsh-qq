/** 表情包工具：list_stickers / send_sticker。 */
import { parseChatKey } from './transport.js'

function toolError(message) {
  return { ok: false, message }
}

export function createStickerTools({ store, transport, chatKeyOf, modeOf, clock = () => Date.now() }) {
  return [
    {
      name: 'list_stickers',
      description:
        '列出当前 QQ 对话可用的表情包（含待整理候选），按标签/来源文本搜索。只在聊天模式使用；' +
        '返回 id/状态/标签/来源文本。没有合适候选时不要硬发。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '标签或来源文本关键词' },
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
        const items = store.list(chatKey, { query: String(args?.query ?? ''), limit: Number(args?.limit) || 20 })
        if (items.length === 0) return { ok: true, message: '当前对话没有匹配的表情包。', items: [] }
        const lines = items.map(item => `- ${item.id} · ${item.state === 'library' ? '收藏' : '候选'}${item.tags.length ? ` · ${item.tags.join('/')}` : ''}${item.sourceText ? ` · 来源：${item.sourceText}` : ''}`)
        return { ok: true, message: ['当前可用表情（用 send_sticker 发送）：', ...lines].join('\n'), items }
      },
    },
    {
      name: 'send_sticker',
      description:
        '从当前对话的表情包图库挑一张发出去。仅在聊天模式、图库启用时可用；合适才发，每轮最多一张，' +
        '严肃/争执/求助优先文字；没有贴切候选就不发。可用 id 精确发送，或 query 按标签/来源文本搜索。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '精确的表情 id' },
          query: { type: 'string', description: '标签/来源文本关键词' },
          tag: { type: 'string', description: '情绪标签，如 happy/angry/sad/shy/confused/daily' },
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
        const route = parseChatKey(chatKey)
        const result = await store.send({
          chatKey,
          target: route.target,
          transport,
          route: { transportKind: route.transportKind, accountId: route.accountId },
          mode: modeOf(chatKey),
          id: String(args?.id ?? ''),
          query: String(args?.query ?? ''),
          tag: String(args?.tag ?? ''),
        })
        if (result.ok !== true) return toolError(result.error ?? '发送失败')
        return { ok: true, message: '表情包已发送。', id: result.id }
      },
    },
  ]
}

export default createStickerTools
