/** Ordered chat output; selectors never accept a destination from the model. */
export const MAX_CHAT_ACTIONS = 4

export function normalizeReplyActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_CHAT_ACTIONS) throw new Error('每次回复需要 1–4 个文字或表情动作。')
  let chars = 0
  return actions.map(action => {
    if (action?.type === 'text') {
      const text = String(action.text ?? '').trim()
      chars += text.length
      if (!text || chars > 260) throw new Error('文字不能为空，整条回复的文字合计最多 260 字。')
      return { type: 'text', text, replyToMessageId: String(action.replyToMessageId ?? '') }
    }
    if (action?.type === 'sticker') {
      const selector = { type: 'sticker', id: String(action.id ?? ''), query: String(action.query ?? ''), tag: String(action.tag ?? '') }
      if (!selector.id && !selector.query && !selector.tag) throw new Error('表情动作需要 id、query 或 tag。')
      return selector
    }
    throw new Error('仅支持 text 和 sticker 动作。')
  })
}

export function createChatReplyTool({ dispatchReply }) {
  return {
    name: 'send_chat_reply',
    description: '把本轮完整回复按 actions 顺序发到当前 QQ 对话，可图→短句→图，也可只发文字。接梗、互怼或情绪变化时可主动搭配一张表情；先 list_stickers 看画面描述，选贴切且可用的图，无需每次发图。最多 4 个动作、文字合计 260 字。默认不引用；只有需要指明较早消息或多话题中的回复对象时才引用，并使用当前上下文中的真实消息 ID，不给每条气泡重复引用。发送成功后本轮不再自动补发最终文字；失败时根据实际已发送数量决定是否补充，勿重发已送出的内容。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['actions'],
      properties: { actions: { type: 'array', minItems: 1, maxItems: MAX_CHAT_ACTIONS, items: {
        type: 'object', additionalProperties: false, required: ['type'],
        properties: {
          type: { type: 'string', enum: ['text', 'sticker'] },
          text: { type: 'string' }, replyToMessageId: { type: 'string', description: '可选；普通接话请省略。仅在确需定位回复对象时填写当前对话可见的消息 ID。' },
          id: { type: 'string' }, query: { type: 'string' }, tag: { type: 'string' },
        },
      } } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['ok', 'message'], properties: { ok: { type: 'boolean' }, message: { type: 'string' }, sentCount: { type: 'integer' } } },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    async execute(args, exec) {
      try { return await dispatchReply(normalizeReplyActions(args?.actions), exec) }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error), sentCount: 0 } }
    },
  }
}
