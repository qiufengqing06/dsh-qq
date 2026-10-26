/** Read-only persona inspection and a bounded model call without agents, tools or QQ delivery. */
import { randomUUID } from 'node:crypto'
import { CHAT_MODE_NOTE, clipChatReply } from './bridge.js'
import { MAX_PROMPT_CHARS, normalizePersonaStickerIds } from './store.js'
import { parseChatKey } from './transport.js'

const NOTICE = '这里展示 QQ 插件注入的人设和聊天规则，不含宿主其他提示与真实群历史。试聊只在本页显示，不保存人设、不发送到 QQ；会使用所显示模型的额度。'

export function createPersonaPreview({ ctx, config, store, stickers = null, control = null, timeoutMs = 60_000 }) {
  let active = null

  function modelFor(chatKey) {
    // store.chat() creates a record for unknown keys; inspection must remain read-only.
    const chat = chatKey && store.chatKeys().includes(chatKey) ? store.chat(chatKey) : null
    if (typeof chat?.model === 'string' && chat.model.includes('/')) {
      const [provider, ...parts] = chat.model.split('/')
      return { provider, model: parts.join('/'), ...(chat.reasoning ? { reasoningEffort: chat.reasoning } : {}) }
    }
    // Reuse the channel's read-only selection, including its unavailable-model fallback.
    if (typeof control?.defaultSelection === 'function') return control.defaultSelection()
    const configured = config.agentOptions ?? {}
    if (configured.provider && configured.model) {
      return { provider: configured.provider, model: configured.model,
        ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {}) }
    }
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    return selection?.provider && selection?.model
      ? { provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      : null
  }

  function inspect(body = {}) {
    const chatKey = typeof body.chatKey === 'string' ? body.chatKey.trim() : ''
    if (chatKey) parseChatKey(chatKey)
    if (body.mode !== undefined && body.mode !== 'chat' && body.mode !== 'work') throw new Error('模式必须是 chat 或 work')
    const mode = body.mode ?? (chatKey ? store.modeFor(chatKey) : 'chat')
    let effective
    if (body.draft !== undefined) {
      const draft = body.draft
      if (!draft || typeof draft.text !== 'string' || !draft.text.trim()) throw new Error('请先填写人设正文')
      if (draft.text.length > MAX_PROMPT_CHARS) throw new Error(`人设正文最多 ${MAX_PROMPT_CHARS} 字`)
      effective = { source: 'draft', text: draft.text, personaId: String(draft.id ?? ''),
        personaName: String(draft.name ?? '').slice(0, 40), stickerIds: normalizePersonaStickerIds(draft.stickerIds ?? [], { strict: true }) }
    } else if (body.personaId) {
      const persona = store.personaOf(body.personaId)
      if (!persona) throw new Error('人设不存在')
      effective = { source: 'persona', text: persona.text, personaId: persona.id,
        personaName: persona.name, stickerIds: persona.stickerIds ?? [] }
    } else {
      effective = store.effectivePromptFor(chatKey, mode)
    }
    const stickerIds = effective.stickerIds ?? []
    // With a destination, use the exact same visibility and cooldown checks as real selection.
    const visible = chatKey && stickers?.list ? stickers.list(chatKey, { ids: stickerIds, limit: 40 }) : []
    const selected = stickerIds.map(id => {
      const item = chatKey ? visible.find(item => item.id === id) : stickers?.itemOf?.(id)
      const preferenceOff = stickers?.enabled === false || mode !== 'chat' || (chatKey && store.chatPreference?.(chatKey)?.stickers === false)
      const available = Boolean(item && item.state !== 'trash' && item.available !== false && !preferenceOff)
      return { id, desc: item?.desc ?? '', tags: item?.tags ?? [], preferred: true, available,
        reason: stickers?.enabled === false ? '图库未启用' : preferenceOff ? '此模式或对话已关闭表情' : !item || item.state === 'trash' ? '当前对话不可用或已移除' : item.reason ?? '' }
    })
    const chatNote = mode === 'chat' ? CHAT_MODE_NOTE : ''
    return { ok: true, effective: { ...effective, mode, chatKey, personaId: effective.personaId ?? '',
      personaName: effective.personaName ?? '', stickerIds, stickers: selected, stickerCount: stickerIds.length,
      chatNote, combinedPrompt: [effective.text, chatNote].filter(Boolean).join('\n\n'), notice: NOTICE }, model: modelFor(chatKey) }
  }

  async function run(body, { signal } = {}) {
    const result = inspect(body)
    if (body.message === undefined) return result
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1000) throw new Error('试聊内容需要 1–1000 字')
    const history = body.history ?? []
    if (!Array.isArray(history) || history.length > 12 || history.some(item => !item || !['user', 'assistant'].includes(item.role)
      || typeof item.content !== 'string' || item.content.length > 1000)) throw new Error('试聊历史最多 12 条，每条不超过 1000 字')
    const llm = ctx.get?.('llm')
    if (!llm?.stream || !result.model) throw new Error('没有可用的试聊模型，请先在 DSH 中配置默认模型')
    if (active) throw new Error('另一次试聊还在生成，请稍后重试')
    const controller = new AbortController()
    active = controller
    const cancel = () => controller.abort(new Error('试聊已取消'))
    const timer = setTimeout(() => controller.abort(new Error('试聊超时，请稍后重试')), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason ?? new Error('试聊已取消')) })
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
    if (controller.signal.aborted) rejectAbort()
    const generate = async () => {
      let text = ''
      let finish = null
      const selection = typeof llm.resolveCallConfig === 'function'
        ? await llm.resolveCallConfig(result.model, controller.signal) : result.model
      controller.signal.throwIfAborted()
      const messages = [...history, { role: 'user', content: body.message.trim() }].map(item => ({
        role: item.role, content: [{ type: 'text', text: item.content }],
        ...(item.role === 'assistant' ? { id: randomUUID(), source: { kind: 'model', provider: selection.provider, model: selection.model } } : {}),
      }))
      for await (const chunk of llm.stream({ ...selection, messages, tools: [], maxTokens: 512,
        system: [result.effective.combinedPrompt, '本次为独立的文字试聊，只输出角色的简短台词，不调用工具，不声称已发图片或执行操作。'].filter(Boolean).join('\n\n'),
        signal: controller.signal })) {
        controller.signal.throwIfAborted()
        if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
        if (chunk?.type === 'finish') finish = chunk.reason
        if (text.length > 4000) throw new Error('试聊输出过长，请重试')
      }
      if (finish && !['stop', 'length', 'max-tokens'].includes(finish.kind)) throw new Error('试聊模型未正常返回，请检查模型配置后重试')
      if (!text.trim()) throw new Error('模型没有返回文字，请重试')
      return { ...result, model: { provider: selection.provider, model: selection.model }, reply: clipChatReply(text) }
    }
    try {
      return await Promise.race([generate(), aborted])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', rejectAbort)
      if (!controller.signal.aborted) controller.abort()
      if (active === controller) active = null
    }
  }

  return { inspect, run, dispose: () => active?.abort(new Error('插件已卸载，试聊已取消')) }
}
