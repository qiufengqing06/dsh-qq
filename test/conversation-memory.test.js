import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { createGroupMemory } from '../lib/group-memory.js'
import { createConversationState } from '../lib/conversation-state.js'
import { createConversationMemory, createConversationMemoryTool } from '../lib/conversation-memory.js'
import { createPersonaPreview } from '../lib/persona-preview.js'
import { resolveConfig } from '../lib/config.js'
import { makeInboundEvent } from '../lib/transport.js'

const CHAT = 'onebot:100:group:a', OTHER = 'onebot:100:group:b'
async function fixture(t, groupOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-conversation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore({ dir })
  await store.load()
  for (const key of [CHAT, OTHER]) await store.setMode(key, 'chat')
  await store.setPersona('fish', { text: '基础鱼人设' })
  for (const key of [CHAT, OTHER]) await store.bindPersona(key, 'fish', 'chat')
  const config = resolveConfig({ dataDir: dir, transport: 'mock', groupMemory: { enabled: true, ...groupOptions } })
  const groupMemory = createGroupMemory({ dir, config })
  const state = createConversationState({ dir })
  const memory = createConversationMemory({ state, store, groupMemory, config })
  t.after(() => memory.dispose())
  let current
  const invalidated = []
  memory.attach({ memoryContextForSession: () => current,
    invalidateContext: async (...args) => invalidated.push(args), invalidateReplies: (...args) => invalidated.push(args) })
  async function manage(body = {}, key = CHAT) {
    const view = await memory.query({ chatKey: key, mode: 'chat' })
    return memory.manage({ chatKey: key, mode: 'chat', expectedRevision: view.revision, ...body })
  }
  async function turn(id = 'm1', text = '我喜欢短句', chatKey = CHAT) {
    const ev = makeInboundEvent({ transportKind: 'onebot', accountId: '100', target: { kind: 'group', groupId: chatKey === CHAT ? 'a' : 'b' },
      sender: { id: 'alice', name: '同名群友' }, text, messageId: id, timestamp: Date.now() })
    const meta = { mode: 'chat', turnId: `turn-${id}`, sessionId: `session-${chatKey}`, personaIdentity: 'fish',
      promptRevision: store.promptRevision(chatKey, 'chat'), events: [ev] }
    const prepared = await memory.prepare(ev, meta)
    current = { ...meta, chatKey, prepared }
    return current
  }
  return { dir, config, store, state, memory, groupMemory, manage, turn, invalidated,
    exec: { agent: { session: { id: 'real-session' } } } }
}

test('真实回合候选只在成功结束提交，基础卡和其他群不变', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'settings', learningEnabled: true })
  const before = f.store.personaOf('fish')
  const context = await f.turn()
  const tool = createConversationMemoryTool(f.memory)
  const result = await tool.execute({ action: 'propose', operations: [{ type: 'fact', kind: 'preference', key: 'reply.length',
    subjectId: 'alice', explicit: true, text: '喜欢短句', sourceIds: ['m1'] }] }, f.exec)
  assert.equal(result.staged, true)
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 0)
  await f.memory.onTurnEnd(context, { success: true })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 1)
  assert.equal((await f.memory.query({ chatKey: OTHER, mode: 'chat' })).total, 0)
  assert.deepEqual(f.store.personaOf('fish'), before)
  await f.memory.onTurnEnd(context, { success: true })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 1)
})

test('冻结后迟到候选、失败和取消回合不能写入', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'settings', learningEnabled: true })
  let context = await f.turn()
  const op = id => [{ type: 'fact', kind: 'preference', key: 'reply.length', subjectId: 'alice', explicit: true, text: '喜欢短句', sourceIds: [id] }]
  f.memory.propose(f.exec, op('m1'))
  await f.manage({ action: 'settings', learningPaused: true })
  await f.memory.onTurnEnd(context, { success: true })
  await f.manage({ action: 'settings', learningPaused: false })
  context = await f.turn('m2')
  f.memory.propose(f.exec, op('m2'))
  await f.memory.onTurnEnd(context, { success: false })
  context = await f.turn('m3')
  f.memory.propose(f.exec, op('m3'))
  f.memory.onCancel(context)
  await f.memory.onTurnEnd(context, { success: true })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 0)
})

test('精确遗忘阻断旧候选并通知会话隔离，旧版本编辑报冲突', async t => {
  const f = await fixture(t)
  const created = await f.manage({ action: 'create', key: 'food', text: '不吃香菜', subjectId: 'alice' })
  await f.manage({ action: 'forget', id: created.recordId })
  const view = await f.memory.query({ chatKey: CHAT, mode: 'chat' })
  assert.equal(view.total, 0)
  assert.equal(view.contextResetPending, true)
  assert.equal(f.invalidated.length, 1)
  assert.ok(view.minRestorableContextEpoch > 0)
  await assert.rejects(f.manage({ action: 'create', key: 'food', text: '不吃香菜', subjectId: 'alice' }), /重新记住/)
  await assert.rejects(f.manage({ action: 'create', text: '新记录', expectedRevision: created.revision }), /更新|版本/)
  await f.manage({ action: 'relearn', tombstoneId: view.tombstones[0].id, text: '现在喜欢香菜' })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 1)
})

test('只读预演不创建新范围、不改磁盘或当前卡，新草稿不继承旧角色习惯', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'create', key: 'topic', text: '群约定周末打游戏', pinned: true })
  await f.manage({ action: 'editHabit', dimension: 'length', value: '每次短句', subjectId: '' })
  const files = await readdir(join(f.dir, 'conversation-state', 'v1'))
  const beforeFiles = await Promise.all(files.map(file => readFile(join(f.dir, 'conversation-state', 'v1', file), 'utf8')))
  const beforeStore = f.store.snapshot()
  const preview = createPersonaPreview({ ctx: { get: () => null }, config: {}, store: f.store, memory: f.memory })
  t.after(() => preview.dispose())
  const result = await preview.run({ chatKey: CHAT, mode: 'chat', draft: { text: '新角色草稿' }, memorySnapshot: { chatKey: CHAT, mode: 'chat' } })
  assert.equal(result.memorySnapshot.readOnly, true)
  assert.match(result.effective.combinedPrompt, /周末打游戏/)
  assert.doesNotMatch(result.effective.combinedPrompt, /每次短句/)
  await assert.rejects(preview.run({ chatKey: CHAT, mode: 'chat', memorySnapshot: { chatKey: OTHER, mode: 'chat' } }), /必须与预演/)
  await assert.rejects(preview.run({ chatKey: 'onebot:100:group:unknown', mode: 'chat', memorySnapshot: { chatKey: 'onebot:100:group:unknown', mode: 'chat' } }), /已有/)
  assert.deepEqual(f.store.snapshot(), beforeStore)
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(f.dir, 'conversation-state', 'v1', file), 'utf8'))), beforeFiles)
})

test('暂停长期学习不阻止独立情绪，恢复平静只失效待发', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'settings', learningEnabled: true, learningPaused: true, emotionEnabled: true })
  const context = await f.turn('happy', '哈哈真有趣')
  f.memory.propose(f.exec, [{ type: 'mood', label: 'happy', intensity: 0.4, targetMemberId: 'alice', reason: '一起开玩笑', sourceIds: ['happy'] }])
  await f.memory.onTurnEnd(context, { success: true })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).mood.label, 'happy')
  await f.manage({ action: 'resetMood' })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).mood, null)
  assert.equal(f.invalidated.length, 1)
})

test('工作模式保持旧笔记，管理开关拒绝字符串，绑定变化不能改错角色', async t => {
  const f = await fixture(t)
  await f.groupMemory.editNotes(CHAT, { action: 'add', text: '工作笔记' }, 'work')
  const view = await f.memory.query({ chatKey: CHAT, mode: 'work' })
  assert.equal(view.legacy, true)
  assert.match(view.items[0].text, /工作笔记/)
  await assert.rejects(f.manage({ action: 'settings', learningEnabled: 'false' }), /布尔/)
  await assert.rejects(f.manage({ action: 'resetHabits', personaIdentity: 'wrong' }), /人设已变化/)
})

test('同一逻辑回合消费了补充消息后淘汰旧候选，允许按新来源重新提出', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'settings', learningEnabled: true })
  const first = await f.turn('first', '我喜欢香菜')
  const op = (id, text) => [{ type: 'fact', kind: 'preference', key: 'food', subjectId: 'alice', explicit: true, text, sourceIds: [id] }]
  f.memory.propose(f.exec, op('first', '喜欢香菜'))
  const revised = await f.turn('correction', '说错了，我不喜欢香菜')
  revised.turnId = first.turnId
  revised.prepared.evidence.forEach(row => { row.turnId = first.turnId })
  f.memory.onConsumed(revised)
  f.memory.propose(f.exec, op('correction', '不喜欢香菜'))
  await f.memory.onTurnEnd(revised, { success: true })
  assert.deepEqual((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).items.map(item => item.text), ['不喜欢香菜'])
})

test('同宿主结束时原子提交多逻辑回合，最终身份或人设内容变化会丢弃旧候选', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'settings', learningEnabled: true })
  const entries = []
  for (const [id, text] of [['short', '我喜欢短句'], ['fish', '我喜欢吃鱼']]) {
    const context = await f.turn(id, text)
    context.hostTurnId = 'one-host-turn'
    f.memory.propose(f.exec, [{ type: 'fact', kind: 'preference', key: id, text, subjectId: 'alice', explicit: true, sourceIds: [id] }])
    entries.push({ context, result: { success: true } })
  }
  await f.memory.onTurnEndBatch(entries)
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 2)
  const stale = await f.turn('stale', '我喜欢冷笑话')
  f.memory.propose(f.exec, [{ type: 'fact', kind: 'preference', key: 'stale', text: '喜欢冷笑话', subjectId: 'alice', explicit: true, sourceIds: ['stale'] }])
  await f.store.setPersona('fish', { text: '改变过的基础人设' })
  await f.memory.onTurnEnd(stale, { success: true })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).total, 2)
})

test('管理写与人设切换共用队列，先完成的绑定变更不会写错旧角色', async t => {
  const f = await fixture(t)
  await f.store.setPersona('second', { text: '另一人设' })
  const view = await f.memory.query({ chatKey: CHAT, mode: 'chat' })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  const switching = f.memory.withPersonaWrite(async () => { entered(); await wait; await f.store.bindPersona(CHAT, 'second', 'chat') })
  await started
  const write = f.memory.manage({ chatKey: CHAT, mode: 'chat', action: 'editHabit', dimension: 'length', value: '短句',
    personaIdentity: 'fish', expectedRevision: view.revision })
  release()
  await switching
  await assert.rejects(write, /人设已变化/)
  assert.deepEqual((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).habits, [])
})

test('切换人设清旧角色临时情绪，切回不恢复，事实和习惯仍保留', async t => {
  const f = await fixture(t)
  await f.manage({ action: 'settings', emotionEnabled: true })
  await f.manage({ action: 'create', text: '群的约定' })
  await f.manage({ action: 'editHabit', dimension: 'length', value: '短句' })
  const context = await f.turn('happy', '哈哈真有趣')
  f.memory.propose(f.exec, [{ type: 'mood', label: 'happy', intensity: 0.5, targetMemberId: 'alice', reason: '一起开玩笑', sourceIds: ['happy'] }])
  await f.memory.onTurnEnd(context, { success: true })
  assert.equal((await f.memory.query({ chatKey: CHAT, mode: 'chat' })).mood.label, 'happy')
  await f.store.setPersona('second', { text: '另一人设' })
  await f.memory.withPersonaWrite(() => f.store.bindPersona(CHAT, 'second', 'chat'))
  await f.memory.withPersonaWrite(() => f.store.bindPersona(CHAT, 'fish', 'chat'))
  const view = await f.memory.query({ chatKey: CHAT, mode: 'chat' })
  assert.equal(view.mood, null)
  assert.equal(view.total, 1)
  assert.equal(view.habits.length, 1)
})

test('首次迁移失败只读降级仍可聊天，已有遗忘边界的损坏状态绝不回退旧笔记', async t => {
  const f = await fixture(t, { notesMaxChars: 4000 })
  await f.groupMemory.editNotes(CHAT, { action: 'add', text: '长'.repeat(3000) }, 'chat')
  const view = await f.memory.query({ chatKey: CHAT, mode: 'chat' })
  assert.equal(view.readOnly, true)
  assert.equal(view.migration.fallback, true)
  assert.equal(view.items[0].text.length >= 3000, true)
  const context = await f.turn()
  assert.match(context.prepared.context, /只读参考/)
  assert.equal(context.prepared.learningAllowed, false)
  await assert.rejects(f.memory.manage({ chatKey: CHAT, mode: 'chat', action: 'settings', learningEnabled: true, expectedRevision: 0 }), /旧笔记未能转换/)
  await f.groupMemory.writeNoteFile(f.groupMemory.fileNameOf(CHAT, 'chat'), '')
  const created = await f.manage({ action: 'create', text: '被忘掉的旧内容' })
  await f.manage({ action: 'forget', id: created.recordId })
  await f.groupMemory.editNotes(CHAT, { action: 'add', text: '被忘掉的旧内容' }, 'chat')
  const folder = join(f.dir, 'conversation-state', 'v1')
  const files = await readdir(folder)
  assert.equal(files.length, 1)
  await writeFile(join(folder, files[0]), '{invalid-json')
  const reopened = createConversationMemory({ state: createConversationState({ dir: f.dir }), store: f.store,
    groupMemory: f.groupMemory, config: f.config })
  t.after(() => reopened.dispose())
  await assert.rejects(reopened.sessionState(CHAT, 'chat'), /损坏/)
})
