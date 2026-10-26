/** Bind memory operations to a real QQ delivery; the model never selects a destination. */
import { createHash } from 'node:crypto'
import { parseChatKey } from './transport.js'

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const copy = value => structuredClone(value)

export function createConversationMemory({ state, store, groupMemory, config, logger = null }) {
  let bridge = null
  let disposed = false
  let personaWrites = Promise.resolve()
  const pending = new Map()
  const receipts = new Map()
  const fallback = new Map()
  const keyOf = context => `${context.sessionId}\0${context.turnId}`
  const sourceKey = context => JSON.stringify(context.prepared?.evidence?.map(row => row.eventId) ?? [])
  const scopeKey = scope => JSON.stringify([scope.chatKey, scope.mode])
  function withPersonaWrite(run) {
    const next = personaWrites.then(run, run)
    personaWrites = next.catch(() => {})
    return next
  }
  const scopeOf = (chatKey, mode) => {
    parseChatKey(chatKey)
    if (!['work', 'chat'].includes(mode)) throw fail('请选择工作或聊天模式')
    return { chatKey, mode }
  }
  const identityOf = (chatKey, mode) => store.personaIdentityFor?.(chatKey, mode)
    ?? (() => {
      const p = store.effectivePromptFor(chatKey, mode)
      return p.personaId || (p.source === 'chat' ? 'legacy:chat' : p.source === 'default' ? 'legacy:default' : 'legacy:none')
    })()

  function known(chatKey) {
    parseChatKey(chatKey)
    const snap = store.snapshot()
    if (!store.chatKeys().includes(chatKey) && !snap.prompt?.chats?.[chatKey]
      && !snap.personaBindings?.[chatKey] && !snap.personaModeBindings?.[chatKey]) throw fail('请选择已有的 QQ 对话', 404)
  }

  async function load(scope) {
    const group = parseChatKey(scope.chatKey).target.kind === 'group'
    const legacyText = group && config.groupMemory?.enabled !== false
      ? await groupMemory.notesOf(scope.chatKey, scope.mode) : ''
    try {
      const result = await state.load(scope, { legacyText })
      fallback.delete(scopeKey(scope))
      return result
    } catch (error) {
      // Only a never-created state may use the old file. An existing state can contain
      // forget boundaries, so corruption or an unsuccessful later write must fail closed.
      const inspected = await state.inspect(scope)
      if (!legacyText || inspected.exists || inspected.hasData || inspected.hasDeletionBoundary) throw error
      const warning = '旧笔记未能转换为新记忆，聊天暂时只读参考旧笔记，自动学习和情绪已停用。请检查笔记长度、容量或存储权限后重试；原文件保留。'
      const result = { legacy: true, readOnly: true, migration: { fallback: true, warning }, legacyText }
      if (!fallback.has(scopeKey(scope))) logger?.warn?.(`dsh-qq: ${warning}`)
      fallback.set(scopeKey(scope), result)
      return result
    }
  }

  function fallbackView(scope, loaded) {
    const items = loaded.legacyText ? [{ id: 'legacy-chat-readonly', kind: 'legacy', text: loaded.legacyText,
      sourceKind: 'legacy', subject: { kind: 'conversation', id: scope.chatKey }, pinned: false }] : []
    return { ok: true, ...scope, personaIdentity: identityOf(scope.chatKey, scope.mode), revision: 0,
      items, total: items.length, legacy: true, readOnly: true, migration: loaded.migration,
      page: 1, limit: 20, habits: [], candidates: [], tombstones: [], mood: null,
      learning: { enabled: false, paused: false }, emotion: { enabled: false },
      contextEpoch: 0, minRestorableContextEpoch: 0, contextResetPending: false }
  }

  async function query(body) {
    known(body.chatKey)
    const scope = scopeOf(body.chatKey, body.mode ?? store.modeFor(body.chatKey))
    if (scope.mode === 'work') {
      const parsed = parseChatKey(scope.chatKey)
      const text = parsed.target.kind === 'group' ? await groupMemory.notesOf(scope.chatKey, 'work') : ''
      const items = text ? [{ id: 'legacy-work', kind: 'legacy', text, sourceKind: 'legacy', subject: { kind: 'conversation', id: '' }, pinned: false }] : []
      return { ok: true, ...scope, personaIdentity: identityOf(scope.chatKey, 'work'), revision: 0, items, total: items.length,
        legacy: true, readOnly: true, page: 1, limit: 20, habits: [], candidates: [], tombstones: [], mood: null,
        learning: { enabled: false, paused: false }, emotion: { enabled: false } }
    }
    const loaded = await load(scope)
    if (loaded.readOnly) return fallbackView(scope, loaded)
    const personaIdentity = identityOf(scope.chatKey, scope.mode)
    const result = await state.read(scope, { personaIdentity, query: body.query ?? '', kind: body.kind ?? '',
      memberId: body.memberId ?? '', page: Number(body.page ?? 1), limit: Number(body.limit ?? 20) })
    return { ...result, ok: true, ...scope, personaIdentity }
  }

  async function manage(body) {
    known(body.chatKey)
    const scope = scopeOf(body.chatKey, body.mode ?? store.modeFor(body.chatKey))
    if (scope.mode !== 'chat') throw fail('工作模式继续使用旧群笔记入口；新记忆与成长请切换到聊天模式')
    const loaded = await load(scope)
    if (loaded.readOnly) throw fail(loaded.migration.warning, 409)
    const personaIdentity = identityOf(scope.chatKey, scope.mode)
    if (body.personaIdentity !== undefined && body.personaIdentity !== personaIdentity) throw fail('人设已变化，请刷新后再操作', 409)
    if (body.action === 'export') {
      const result = await state.exportLegacy(scope, { personaIdentity, expectedRevision: body.expectedRevision,
        maxChars: config.groupMemory?.notesMaxChars ?? 2000 })
      return { ...result, ...scope, personaIdentity, file: groupMemory.fileNameOf(scope.chatKey, scope.mode) }
    }
    const before = await state.read(scope, { personaIdentity })
    const action = { ...body, personaIdentity }
    delete action.chatKey
    delete action.mode
    if (body.action === 'settings') {
      const learning = {}, emotion = {}
      for (const [field, dest, name] of [['learningEnabled', learning, 'enabled'], ['learningPaused', learning, 'paused'], ['emotionEnabled', emotion, 'enabled']]) {
        if (body[field] !== undefined) {
          if (typeof body[field] !== 'boolean') throw fail(`${field} 必须是布尔值`)
          dest[name] = body[field]
        }
        delete action[field]
      }
      if (Object.keys(learning).length) action.learning = learning
      if (Object.keys(emotion).length) action.emotion = emotion
    }
    const result = await state.mutate(scope, action)
    if (result.contextEpoch !== before.contextEpoch) {
      groupMemory.clearContext?.(scope.chatKey, scope.mode)
      for (const [id, entry] of pending) if (entry.context.chatKey === scope.chatKey && entry.context.mode === scope.mode) pending.delete(id)
      try { await bridge?.invalidateContext?.(scope.chatKey, { mode: scope.mode, keepQueue: false }) }
      catch (error) { logger?.warn?.(`dsh-qq: 记忆已更新，上下文待重建：${error.message}`) }
    } else if (body.action === 'resetMood' || (body.action === 'settings' && (body.emotionEnabled === false || body.emotion?.enabled === false))) {
      bridge?.invalidateReplies?.(scope.chatKey, { mode: scope.mode })
    }
    return { ...result, ok: true, ...scope, personaIdentity }
  }

  async function preview(body, effective) {
    const requested = body.memorySnapshot
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw fail('记忆预演需要明确的对话范围')
    if (requested.chatKey !== effective.chatKey || requested.mode !== effective.mode) throw fail('记忆快照必须与预演对话和模式一致')
    known(requested.chatKey)
    const scope = scopeOf(requested.chatKey, requested.mode)
    if (scope.mode === 'work') {
      const view = await query(scope)
      return { ...scope, personaIdentity: view.personaIdentity, readOnly: true,
        text: view.items.map(item => item.text).join('\n'), recordIds: view.items.map(item => item.id) }
    }
    let personaIdentity = identityOf(scope.chatKey, scope.mode)
    if (effective.source === 'draft' || effective.source === 'persona') {
      const id = effective.personaId
      personaIdentity = id && store.personaOf(id) ? id : 'preview:unbound'
    }
    if (requested.personaId !== undefined && requested.personaId !== effective.personaId) throw fail('记忆快照与预演人设不一致')
    const snapshot = await state.preview(scope, { personaIdentity, query: String(body.message ?? ''),
      senderId: '', maxChars: config.groupMemory?.notesMaxChars ?? 2000 })
    return { ...snapshot, ...scope, personaIdentity, readOnly: true }
  }

  async function prepare(ev, options) {
    const scope = scopeOf(ev.chatKey, options.mode)
    if (scope.mode !== 'chat') return { context: '', evidence: [], learningAllowed: false }
    const loaded = await load(scope)
    if (loaded.readOnly) return { context: config.groupMemory?.enabled === false ? ''
      : `[旧笔记，只读参考，自动学习暂不可用]\n${loaded.legacyText.slice(0, config.groupMemory?.notesMaxChars ?? 2000)}`,
      evidence: [], learningAllowed: false }
    const personaIdentity = options.personaIdentity || identityOf(scope.chatKey, scope.mode)
    const evidence = (options.events ?? [ev]).filter(item => item?.chatKey === scope.chatKey && item?.sender?.id
      && !item.internal && !item.proactive && !item.outbound && (!item.selfId || item.sender.id !== item.selfId))
      .map(item => ({ eventId: item.messageId || createHash('sha256').update(JSON.stringify([
        scope.chatKey, item.sender.id, item.timestamp, item.text, item.replyTo?.messageId,
      ])).digest('hex'), senderId: item.sender.id, receivedAt: Number(item.timestamp) || Date.now(),
        text: String(item.text ?? '').slice(0, 4000), excerpt: String(item.text ?? '').slice(0, 120),
        quotedAuthorId: item.replyTo ? String(item.replyTo.sender?.id || 'unknown-quoted-author') : undefined,
        chatKey: scope.chatKey, mode: scope.mode, turnId: options.turnId }))
    const snapshot = state.snapshot(scope, { personaIdentity, senderId: ev.sender?.id ?? '', query: String(ev.text ?? ''),
      maxChars: config.groupMemory?.notesMaxChars ?? 2000 })
    const enabled = config.groupMemory?.enabled !== false
    const view = await state.read(scope, { personaIdentity, limit: 1 })
    const learningAllowed = enabled && scope.mode === 'chat' && evidence.length > 0
    const note = learningAllowed && ((view.learning.enabled && !view.learning.paused) || view.emotion.enabled)
      ? ['本对话可用 qq_memory 提出有证据的记忆、习惯或短期情绪；不要每句都记。只引用以下真实消息 ID，不把引用作者当发言人，不从自己的回复推断他人偏好。',
          JSON.stringify(evidence.map(item => ({ id: item.eventId, sender: item.senderId, quotedAuthor: item.quotedAuthorId }))),
          '候选只在本轮正常完成后校验保存；工具返回“待校验”时不要声称已永久记住。情绪只修饰表达，不照念状态，不改变权限，不复述表情包描述。'].join('\n') : ''
    return { context: enabled ? [snapshot.text, note].filter(Boolean).join('\n\n') : '',
      snapshot, evidence, expected: state.capture(scope, personaIdentity), learningAllowed }
  }

  function contextFor(exec) {
    const sessionId = String(exec?.agent?.session?.id ?? '')
    const context = bridge?.memoryContextForSession?.(sessionId)
    if (!context || !context.prepared?.learningAllowed || disposed) throw fail('当前没有可学习的真实聊天回合')
    return context
  }

  async function search(exec, queryText = '') {
    const context = contextFor(exec)
    const snapshot = state.snapshot(scopeOf(context.chatKey, context.mode), { personaIdentity: context.personaIdentity,
      senderId: context.events?.at(-1)?.sender?.id ?? '', query: String(queryText).slice(0, 200), maxChars: 1000 })
    return { ok: true, text: snapshot.text, recordIds: snapshot.recordIds ?? [],
      sentSources: (receipts.get(keyOf(context)) ?? []).map(item => ({ id: item.eventId, text: item.text })) }
  }

  function propose(exec, operations) {
    const context = contextFor(exec)
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 3) throw fail('每轮只能提出 1–3 项候选')
    if (JSON.stringify(operations).length > 6000) throw fail('候选过长')
    const key = keyOf(context)
    if (pending.has(key) && sourceKey(pending.get(key).context) === sourceKey(context)) throw fail('本轮已经提交候选，请等待校验')
    // An entry is only created after the model calls the narrow tool; passive chatter does not enqueue work.
    pending.set(key, { context: copy(context), operations: copy(operations), at: Date.now() })
    for (const [id, item] of pending) if (Date.now() - item.at > 120000) pending.delete(id)
    return { ok: true, staged: true, message: '候选已接收，待本轮正常结束后按来源和当前设置校验；尚未永久保存。' }
  }

  function takeBatch(context, result) {
    const key = keyOf(context), entry = pending.get(key)
    pending.delete(key)
    const sent = receipts.get(key) ?? []
    receipts.delete(key)
    if (!entry || disposed || result.success !== true || Date.now() - entry.at > 120000) return
    const captured = entry.context
    if (sourceKey(captured) !== sourceKey(context)
      || store.modeFor(captured.chatKey) !== captured.mode
      || identityOf(captured.chatKey, captured.mode) !== captured.personaIdentity
      || (captured.promptRevision !== undefined && store.promptRevision(captured.chatKey, captured.mode) !== captured.promptRevision)) return
    const operations = entry.operations.filter(op => {
      if (op.type !== 'fact' || (op.kind !== 'episode' && !op.personaScoped)) return true
      // A sent sentence proves that sentence was said, not that an arbitrary promised action was performed.
      return sent.some(row => op.sourceIds?.includes(row.eventId) && row.text === op.text)
    })
    if (!operations.length) return
    return {
      personaIdentity: captured.personaIdentity, operations,
      evidence: [...captured.prepared.evidence, ...sent], expected: captured.prepared.expected, turnId: captured.turnId,
    }
  }

  function onTurnEndBatch(entries) {
    return withPersonaWrite(async () => {
      const groups = new Map()
      for (const { context, result } of entries) {
        const batch = takeBatch(context, result)
        if (!batch) continue
        const scope = scopeOf(context.chatKey, context.mode)
        const key = JSON.stringify([scopeKey(scope), context.personaIdentity, context.sessionId, context.hostTurnId])
        if (!groups.has(key)) groups.set(key, { scope, batches: [], hostTurnId: context.hostTurnId })
        groups.get(key).batches.push(batch)
      }
      for (const { scope, batches, hostTurnId } of groups.values()) {
        const applied = await state.applyProposalBatches(scope, { batches, hostTurnId })
        if (applied.rejected?.length) logger?.info?.(`dsh-qq: 记忆候选 ${applied.applied ?? 0} 项生效，${applied.rejected.length} 项未通过校验`)
      }
    })
  }

  return {
    state, query, manage: body => withPersonaWrite(() => manage(body)), preview, prepare, search, propose, identityOf,
    withPersonaWrite(run) {
      return withPersonaWrite(async () => {
        const previous = store.chatKeys().map(chatKey => [chatKey, identityOf(chatKey, 'chat')])
        const result = await run()
        for (const [chatKey, identity] of previous) {
          if (identityOf(chatKey, 'chat') === identity) continue
          try { await state.resetMood(scopeOf(chatKey, 'chat'), identity) }
          catch (error) { logger?.warn?.(`dsh-qq: 人设已切换，旧情绪清理失败：${error.message}`) }
        }
        return result
      })
    },
    attach(value) { bridge = value },
    summary(chatKey, mode) { const scope = scopeOf(chatKey, mode); const result = fallback.get(scopeKey(scope)); return result
      ? { loaded: true, readOnly: true, migration: result.migration, learning: { enabled: false, paused: false }, emotion: { enabled: false } }
      : state.summary(scope) },
    async sessionState(chatKey, mode) { const scope = scopeOf(chatKey, mode); if (mode !== 'chat') return { contextEpoch: 0, minRestorableContextEpoch: 0, contextResetPending: false }; const loaded = await load(scope); return loaded.readOnly ? fallbackView(scope, loaded) : state.read(scope, { personaIdentity: identityOf(chatKey, mode), limit: 1 }) },
    onSessionReady({ chatKey, mode, contextEpoch }) { const scope = scopeOf(chatKey, mode); if (mode === 'chat' && !fallback.has(scopeKey(scope))) return state.markContextReady(scope, contextEpoch) },
    onNewSession({ chatKey, mode, personaIdentity }) { if (mode === 'chat') return state.resetMood(scopeOf(chatKey, mode), personaIdentity || identityOf(chatKey, mode)) },
    onAccepted() {},
    onConsumed(context) { const key = keyOf(context), entry = pending.get(key); if (entry && sourceKey(entry.context) !== sourceKey(context)) pending.delete(key) },
    onSent(context, { action, result }) {
      if (disposed || action?.type !== 'text' || result?.ok !== true || !result.messageId) return
      const key = keyOf(context)
      const rows = receipts.get(key) ?? []
      rows.push({ eventId: `sent:${result.messageId}`, senderId: 'self', text: action.text,
        excerpt: action.text.slice(0, 120), receivedAt: Date.now(), turnId: context.turnId,
        chatKey: context.chatKey, mode: context.mode, outbound: true, sent: true, receiptId: String(result.messageId) })
      receipts.set(key, rows.slice(-4))
    },
    onTurnEnd: (context, result) => onTurnEndBatch([{ context, result }]), onTurnEndBatch,
    onCancel(context) { if (context) { pending.delete(keyOf(context)); receipts.delete(keyOf(context)) } },
    async removePersona(id) { await state.removePersona(id) },
    async dispose() { disposed = true; pending.clear(); receipts.clear(); await personaWrites; await state.flush?.(); await state.dispose?.() },
  }
}

export function createConversationMemoryTool(memory) {
  const operation = {
    type: 'object', additionalProperties: false, required: ['type', 'sourceIds'],
    properties: {
      type: { type: 'string', enum: ['fact', 'habit', 'mood'] },
      sourceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
      kind: { type: 'string', enum: ['preference', 'fact', 'agreement', 'episode'] },
      text: { type: 'string', maxLength: 240 }, key: { type: 'string', maxLength: 80 },
      subjectId: { type: 'string', maxLength: 128 }, explicit: { type: 'boolean' }, personaScoped: { type: 'boolean' },
      expiresAt: { type: 'number' },
      dimension: { type: 'string', enum: ['length', 'order', 'banter', 'address', 'stickers'] }, value: { type: 'string', maxLength: 80 },
      label: { type: 'string', enum: ['calm', 'happy', 'proud', 'confused', 'sulky'] }, intensity: { type: 'number', minimum: 0, maximum: 1 },
      targetMemberId: { type: 'string', maxLength: 128 }, topicKey: { type: 'string', maxLength: 80 }, reason: { type: 'string', maxLength: 120 },
    },
  }
  return {
    name: 'qq_memory',
    description: '读取当前 QQ 对话相关记忆，或提出最多3项有真实来源的记忆/习惯/临时情绪候选。不得捏造来源、跨对话、记自己的猜测、把引用当本人偏好；explicit仅本人明确偏好或更正。一次玩笑不能改变长期习惯。角色经历只记录已发出的原话，先search获取sentSources，逐字填写text并引用对应id；发送一句话不证明实际完成了某项任务。候选待正常回合结束校验，不等于已保存。不开启后台模型任务。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['search', 'propose'] }, query: { type: 'string', maxLength: 200 },
      operations: { type: 'array', minItems: 1, maxItems: 3, items: operation },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      try {
        if (args?.action === 'search') return await memory.search(exec, args.query)
        if (args?.action === 'propose') return memory.propose(exec, args.operations)
        throw fail('未知记忆操作')
      } catch (error) { return { ok: false, message: error.message } }
    },
  }
}
