import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationState } from '../lib/conversation-state.js'

const A = { chatKey: 'onebot:100:group:200', mode: 'chat' }
const B = { chatKey: 'onebot:100:group:201', mode: 'chat' }
const DM = { chatKey: 'onebot:100:dm:300', mode: 'chat' }
const ID = 'fish'
const START = 1800000000000
const DAY = 86400000

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-conversation-'))
  let at = START
  const state = createConversationState({ dir, now: () => at })
  t.after(async () => { await state.dispose(); await rm(dir, { recursive: true, force: true }) })
  await state.load(A)
  const read = (scope = A, options = {}) => state.read(scope, { personaIdentity: ID, ...options })
  const manage = async (args, scope = A) => state.mutate(scope, { personaIdentity: ID, expectedRevision: (await read(scope)).revision, ...args })
  const ev = (id, senderId = 'alice', extra = {}) => ({ eventId: id, senderId, receivedAt: at, text: '我喜欢短句接梗', chatKey: A.chatKey, mode: A.mode, ...extra })
  const submit = (operations, evidence, options = {}) => state.applyProposals(A, { personaIdentity: ID, turnId: `t-${at}-${evidence[0]?.eventId}`,
    expected: state.capture(A, ID), operations, evidence, ...options })
  return { state, dir, read, manage, ev, submit, setTime: value => { at = value }, time: () => at }
}

test('defaults, read-only preview, independent scopes and shared persona facts', async t => {
  const h = await setup(t)
  assert.equal((await h.read()).learning.enabled, false)
  assert.equal((await h.read()).emotion.enabled, false)
  assert.deepEqual(await readdir(h.dir), [])
  assert.equal(h.state.summary(B).loaded, false)
  assert.equal((await h.state.preview(B, { personaIdentity: ID })).text, '')
  await h.state.load(B, { readOnly: true, legacyText: '- 不应迁移' })
  assert.equal(h.state.summary(B).loaded, false)
  assert.deepEqual(await readdir(h.dir), [])
  const fact = await h.manage({ action: 'create', kind: 'preference', subjectId: 'alice', key: 'food.cilantro', text: '不吃香菜' })
  assert.equal((await h.read(A, { personaIdentity: 'other' })).total, 1)
  assert.equal((await h.read(B)).total, 0)
  assert.equal((await h.read(DM)).total, 0)
  assert.equal((await h.read({ ...A, mode: 'work' })).total, 0)
  const episode = await h.manage({ action: 'create', kind: 'episode', text: '我在本群答应少发长段', key: 'promise.length' })
  assert.equal((await h.read(A, { personaIdentity: 'other' })).total, 1)
  const snap = h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice', query: '香菜' })
  assert.ok(snap.recordIds.includes(fact.recordId))
  assert.ok(!snap.recordIds.includes(episode.recordId))
  const before = JSON.stringify(await h.read())
  h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice', query: '香菜' })
  assert.equal(JSON.stringify(await h.read()), before)
})

test('legacy migration is lossless, idempotent and does not overwrite newer state', async t => {
  const h = await setup(t)
  const long = '旧笔记'.repeat(150)
  const legacy = `# 群笔记\n- ${long}\n- 老约定\n`
  await h.state.load(A, { legacyText: legacy })
  assert.equal((await h.read()).items.find(item => item.text === long)?.sourceKind, 'legacy')
  const revision = (await h.read()).revision
  await h.state.load(A, { legacyText: legacy })
  assert.equal((await h.read()).revision, revision)
  const changed = await h.state.load(A, { legacyText: '- 回滚期间的新内容' })
  assert.equal(changed.migration.legacyChanged, true)
  assert.equal((await h.read()).migration.legacyChanged, true)
  assert.equal((await h.read()).total, 2)
  const id = (await h.read()).items.find(item => item.text === '老约定').id
  await h.manage({ action: 'correct', id, text: '人工核对后的约定' })
  assert.equal((await h.read()).items.find(item => item.id === id).sourceKind, 'manual')
  const other = { ...B }
  await assert.rejects(h.state.load(other, { legacyText: '- ' + '长'.repeat(2001) }), /过长/)
  assert.equal((await h.read(other)).total, 0)
})

test('strict revision conflicts, filtering before pagination and immutable returned objects', async t => {
  const h = await setup(t)
  const stale = (await h.read()).revision
  for (let i = 0; i < 24; i += 1) await h.manage({ action: 'create', text: `香菜约定 ${i}`, kind: i % 2 ? 'fact' : 'preference', subjectId: i % 2 ? 'bob' : 'alice' })
  await assert.rejects(h.state.mutate(A, { action: 'clear', category: 'all', expectedRevision: stale }), error => error.code === 'CONFLICT')
  const view = await h.read(A, { memberId: 'alice', kind: 'preference', query: '香菜', page: 2, limit: 5 })
  assert.equal(view.total, 12)
  assert.equal(view.items.length, 5)
  assert.equal((await h.read(A, { memberId: 'alice', page: 99, limit: 5 })).page, 3)
  assert.equal((await h.read(A, { query: '没有该词', page: 99 })).page, 1)
  view.items[0].text = '污染'
  view.learning.enabled = true
  assert.equal((await h.read()).learning.enabled, false)
  assert.equal((await h.read()).items.some(item => item.text === '污染'), false)
  assert.ok(h.state.snapshot(A, { personaIdentity: ID, query: '香菜', maxChars: 80 }).text.length <= 80)
})

test('source membership, scope, author, quoted text and own output are checked', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const op = { type: 'fact', kind: 'preference', text: '喜欢香菜', key: 'food.cilantro', subjectId: 'alice', explicit: true, sourceIds: ['a'] }
  assert.equal((await h.submit([op], [h.ev('other')])).rejected[0].code, 'FORBIDDEN')
  assert.equal((await h.submit([op], [h.ev('a', 'bob')])).rejected[0].code, 'FORBIDDEN')
  assert.equal((await h.submit([op], [h.ev('a', 'alice', { outbound: true })])).rejected[0].code, 'FORBIDDEN')
  await assert.rejects(h.submit([op], [h.ev('a', 'alice', { chatKey: B.chatKey })]), error => error.code === 'FORBIDDEN')
  assert.equal((await h.submit([op], [h.ev('a', 'alice', { quotedAuthorId: 'bob', text: '他说得对' })])).rejected[0].code, 'FORBIDDEN')
  assert.equal((await h.read()).total, 0)
  assert.equal((await h.read()).candidates.length, 0)
  assert.equal(h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice', query: '香菜' }).text, '')
})

test('explicit self preference commits once; replay is not new evidence or a fresh timestamp', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const op = { type: 'fact', kind: 'preference', text: '不吃香菜', key: 'food.cilantro', subjectId: 'alice', explicit: true, sourceIds: ['a'] }
  const source = h.ev('a', 'alice', { text: '我不吃香菜' })
  const first = await h.submit([op], [source])
  assert.equal(first.applied, 1)
  assert.equal((await h.read()).items[0].sourceKind, 'explicit')
  h.setTime(START + DAY)
  const before = (await h.read()).items[0]
  await h.submit([op], [source], { turnId: 'replayed-in-another-turn' })
  assert.deepEqual((await h.read()).items[0], before)
  assert.equal((await h.submit([op], [source], { turnId: `t-${START}-a` })).duplicate, true)
})

test('slow learning requires independent sources over 24 hours; group habit needs multiple members', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const op = { type: 'habit', dimension: 'length', value: '短句', sourceIds: ['1'] }
  const first = h.ev('1')
  await h.submit([op], [first])
  await h.submit([op], [first], { turnId: 'replay' })
  assert.equal((await h.read()).candidates[0].evidence.length, 1)
  h.setTime(START + DAY / 2)
  await h.submit([{ ...op, sourceIds: ['2'] }], [h.ev('2')])
  h.setTime(START + DAY)
  await h.submit([{ ...op, sourceIds: ['3'] }], [h.ev('3')])
  assert.equal((await h.read()).habits.length, 0, 'single member cannot define the group')
  h.setTime(START + DAY + 1)
  await h.submit([{ ...op, sourceIds: ['4'] }], [h.ev('4', 'bob')])
  assert.equal((await h.read()).habits[0].value, '短句')
  assert.equal((await h.read(A, { personaIdentity: 'other' })).habits.length, 0)
  assert.equal((await h.read(B)).habits.length, 0)
  await h.manage({ action: 'lock', id: (await h.read()).habits[0].id })
  h.setTime(START + 2 * DAY)
  const rejected = await h.submit([{ ...op, value: '长段', sourceIds: ['5'] }], [h.ev('5')])
  assert.equal(rejected.rejected[0].code, 'FORBIDDEN')
})

test('forget removes body and dependent evidence, blocks stale sources, survives reload and needs explicit relearn', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const op = { type: 'fact', kind: 'preference', text: '不吃香菜', key: 'food.cilantro', subjectId: 'alice', explicit: true, sourceIds: ['a'] }
  await h.submit([op], [h.ev('a', 'alice', { text: '我不吃香菜' })])
  const old = h.state.capture(A, ID)
  const id = (await h.read()).items[0].id
  h.setTime(START + 100)
  const forgotten = await h.manage({ action: 'forget', id })
  assert.equal(forgotten.total, 0)
  assert.equal(forgotten.contextResetPending, true)
  assert.equal(forgotten.contextEpoch, forgotten.minRestorableContextEpoch)
  const folder = join(h.dir, 'conversation-state', 'v1')
  const body = await readFile(join(folder, (await readdir(folder)).find(name => name.endsWith('.json'))), 'utf8')
  assert.doesNotMatch(body, /不吃香菜/)
  await h.state.markContextReady(A, forgotten.contextEpoch)
  assert.equal((await h.read()).contextResetPending, false)
  assert.equal((await h.read()).minRestorableContextEpoch, forgotten.contextEpoch)
  await assert.rejects(h.state.markContextReady(A, 0), error => error.code === 'CONFLICT')
  const reloaded = createConversationState({ dir: h.dir, now: () => h.time() })
  t.after(() => reloaded.dispose())
  await reloaded.load(A)
  assert.equal((await reloaded.read(A)).minRestorableContextEpoch, forgotten.contextEpoch)
  const stale = await h.submit([op], [h.ev('a')], { expected: old, turnId: 'old-pending' })
  assert.equal(stale.rejected[0].code, 'CONFLICT')
  h.setTime(START + 200)
  assert.equal((await h.submit([{ ...op, sourceIds: ['new'] }], [h.ev('new')])).rejected[0].code, 'FORBIDDEN')
  const restored = await h.manage({ action: 'relearn', tombstoneId: forgotten.tombstones[0].id, text: '现在可以吃香菜', kind: 'preference' })
  assert.equal(restored.items[0].text, '现在可以吃香菜')
  assert.equal(restored.tombstones.length, 0)
  assert.equal(restored.sourceCutoff, START + 100)
})

test('pause/resume invalidates old learning while emotion remains independent and reset only affects its layer', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true }, emotion: { enabled: true } })
  const old = h.state.capture(A, ID)
  await h.manage({ action: 'settings', learning: { paused: true } })
  const mood = { type: 'mood', label: 'happy', intensity: 0.8, targetMemberId: 'alice', reason: '甲分享了好消息', sourceIds: ['a'] }
  const fact = { type: 'fact', kind: 'preference', text: '喜欢短句', subjectId: 'alice', explicit: true, sourceIds: ['a'] }
  const mixed = await h.submit([fact, mood], [h.ev('a')])
  assert.equal(mixed.rejected.length, 1)
  assert.equal((await h.read()).mood.label, 'happy')
  await h.manage({ action: 'settings', learning: { paused: false } })
  assert.equal((await h.submit([fact], [h.ev('a')], { expected: old, turnId: 'late' })).rejected[0].code, 'CONFLICT')
  const current = h.state.capture(A, ID)
  await h.state.resetMood(A, ID)
  assert.equal((await h.submit([fact], [h.ev('a')], { expected: current, turnId: 'fact-after-mood-reset' })).applied, 1)
  assert.equal((await h.read()).mood, null)
})

test('mood is targeted, decays without writes, expires and never persists across restart', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', emotion: { enabled: true } })
  const mood = { type: 'mood', label: 'sulky', intensity: 0.8, targetMemberId: 'alice', reason: '甲轻松调侃', sourceIds: ['a'] }
  await h.submit([mood], [h.ev('a')])
  assert.equal(h.state.snapshot(A, { personaIdentity: ID, senderId: 'bob' }).mood, null)
  assert.equal(h.state.snapshot(A, { personaIdentity: 'other', senderId: 'alice' }).mood, null)
  h.setTime(START + 600000)
  assert.ok(Math.abs((await h.read()).mood.intensity - 0.4) < 1e-10)
  const file = join(h.dir, 'conversation-state', 'v1', (await readdir(join(h.dir, 'conversation-state', 'v1')))[0])
  const before = await readFile(file, 'utf8')
  for (let i = 0; i < 5; i += 1) h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice' })
  assert.equal(await readFile(file, 'utf8'), before)
  assert.doesNotMatch(before, /甲轻松调侃|sulky/)
  const another = createConversationState({ dir: h.dir, now: () => h.time() })
  t.after(() => another.dispose())
  assert.equal((await another.read(A, { personaIdentity: ID })).mood, null)
  await h.manage({ action: 'resetHabits' })
  assert.notEqual((await h.read()).mood, null)
  h.setTime(START + 1800000)
  assert.equal((await h.read()).mood, null)
})

test('persona deletion invalidates pending work and same-ID recreation, without touching unrelated scopes', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  await h.manage({ action: 'create', text: '群事实', key: 'group.fact' })
  await h.manage({ action: 'create', text: '我的角色承诺', kind: 'episode', key: 'role.promise' })
  await h.manage({ action: 'editHabit', dimension: 'length', value: '短句' })
  await h.state.load(B)
  const untouched = await h.read(B)
  const expected = h.state.capture(A, ID)
  await h.state.removePersona(ID)
  assert.deepEqual(await h.read(B), untouched)
  const view = await h.read()
  assert.equal(view.total, 1)
  assert.equal(view.habits.length, 0)
  const result = await h.submit([{ type: 'habit', dimension: 'length', value: '短句', sourceIds: ['new'] }], [h.ev('new')], { expected })
  assert.equal(result.rejected[0].code, 'CONFLICT')
})

test('actual outgoing receipt is required for own promise; user claim cannot prove it', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const op = { type: 'fact', kind: 'episode', text: '我答应下次少发长段', key: 'promise.length', sourceIds: ['a'] }
  assert.equal((await h.submit([op], [h.ev('a', 'alice', { text: '你答应过的' })])).rejected.length, 1)
  const receipt = h.ev('sent', 'self', { outbound: true, sent: true, receiptId: 'platform-message', text: '答应你，下次短点' })
  assert.equal((await h.submit([{ ...op, sourceIds: ['sent'] }], [receipt])).applied, 1)
  assert.equal((await h.read()).items[0].personaIdentity, ID)
  assert.equal((await h.read(A, { personaIdentity: 'other' })).total, 0)
})

test('failed operation does not partially mutate another accepted operation; work proposals are denied', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const result = await h.submit([
    { type: 'habit', dimension: 'identity', value: '换个角色', sourceIds: ['a'] },
    { type: 'fact', kind: 'preference', text: '喜欢短句', subjectId: 'alice', explicit: true, sourceIds: ['a'] },
  ], [h.ev('a')])
  assert.equal(result.applied, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal((await h.read()).habits.length, 0)
  const work = { ...A, mode: 'work' }
  await h.state.load(work)
  const refused = await h.state.applyProposals(work, { personaIdentity: ID, expected: h.state.capture(work, ID), turnId: 'work',
    operations: [{ type: 'habit', dimension: 'length', value: '短句', sourceIds: ['a'] }], evidence: [h.ev('a', 'alice', { mode: 'work' })] })
  assert.equal(refused.rejected[0].code, 'FORBIDDEN')
})

test('automatic proposals cannot override bound fields or manufacture another member', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const op = { type: 'fact', kind: 'preference', text: '喜欢短句', key: 'reply.length', subjectId: 'alice', explicit: true, sourceIds: ['a'] }
  for (const extra of [{ subject: { kind: 'member', id: 'bob' } }, { sourceKind: 'manual' }, { personaIdentity: 'other' }, { pinned: true }, { explicit: 'true' }]) {
    const result = await h.submit([{ ...op, ...extra }], [h.ev('a')], { turnId: JSON.stringify(extra) })
    assert.equal(result.rejected[0].code, 'INVALID_INPUT')
  }
  assert.equal((await h.read()).total, 0)
  await h.manage({ action: 'create', kind: 'preference', subjectId: 'alice', key: 'reply.length', text: '希望回答详尽' })
  assert.equal((await h.submit([op], [h.ev('a')])).rejected[0].code, 'FORBIDDEN')
  assert.equal((await h.read()).items[0].text, '希望回答详尽')
})

test('concurrent revisions have one winner; capacity never evicts pinned or explicit records', async t => {
  const h = await setup(t)
  const revision = (await h.read()).revision
  const writes = await Promise.allSettled(['a', 'b'].map(value => h.state.mutate(A, {
    action: 'create', text: value, key: value, expectedRevision: revision,
  })))
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(writes.filter(result => result.status === 'rejected' && result.reason.code === 'CONFLICT').length, 1)
  for (let i = 0; i < 5; i += 1) await h.manage({ action: 'editHabit', dimension: 'address', value: `称呼${i}`, subjectId: `member${i}` })
  await assert.rejects(h.manage({ action: 'editHabit', dimension: 'address', value: '超额', subjectId: 'member6' }), error => error.code === 'CAPACITY')
  assert.equal((await h.read()).habits.length, 5)
  assert.ok((await h.read()).habits.every(item => item.locked))
})

test('negative mood follows a concrete topic, not the member into an unrelated question', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', emotion: { enabled: true } })
  await h.submit([{ type: 'mood', label: 'sulky', intensity: 0.5, targetMemberId: 'alice', topicKey: '香菜', reason: '甲调侃香菜', sourceIds: ['a'] }], [h.ev('a')])
  assert.equal(h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice', query: '今天香菜多少钱' }).mood.label, 'sulky')
  assert.equal(h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice', query: '帮我看看这个编程问题' }).mood, null)
  await h.state.resetMood(A, ID)
  const replay = await h.submit([{ type: 'mood', label: 'sulky', intensity: 0.5, targetMemberId: 'alice', reason: '甲调侃香菜', sourceIds: ['a'] }], [h.ev('a')], { turnId: 'replay-after-reset' })
  assert.equal(replay.rejected[0].code, 'FORBIDDEN')
})

test('locked expression boundary has priority over weak matching facts in a shared budget', async t => {
  const h = await setup(t)
  for (let i = 0; i < 12; i += 1) await h.manage({ action: 'create', text: `香菜故事 ${i} ${'背景'.repeat(30)}` })
  const habit = await h.manage({ action: 'editHabit', dimension: 'banter', value: '不调侃该成员', subjectId: 'alice' })
  const snap = h.state.snapshot(A, { personaIdentity: ID, senderId: 'alice', query: '香菜', maxChars: 300 })
  assert.ok(snap.habitIds.includes(habit.recordId))
  assert.ok(snap.text.length <= 300)
  assert.ok(snap.omitted > 0)
})

test('relationship view derives member boundaries and role episodes without creating a second truth', async t => {
  const h = await setup(t)
  const address = await h.manage({ action: 'editHabit', dimension: 'address', value: '阿明', subjectId: 'alice' })
  await h.manage({ action: 'editHabit', dimension: 'banter', value: '可以轻松互怼', subjectId: 'alice' })
  const episode = await h.manage({ action: 'create', kind: 'episode', subjectId: 'alice', text: '我答应叫甲阿明' })
  const before = (await h.read()).revision
  const view = await h.read()
  assert.equal(view.relationships.length, 1)
  assert.equal(view.relationships[0].memberId, 'alice')
  assert.equal(view.relationships[0].address, '阿明')
  assert.ok(view.relationships[0].habitIds.includes(address.recordId))
  assert.ok(view.relationships[0].recordIds.includes(episode.recordId))
  assert.equal((await h.read()).revision, before)
  assert.equal((await h.read(A, { personaIdentity: 'other' })).relationships.length, 0)
})

test('rollback export excludes forgotten/expired/other-persona records, rejects overflow, and detects subsequent legacy edits', async t => {
  const h = await setup(t)
  await h.state.load(A, { legacyText: '# 原笔记\n- 老事实\n' })
  const old = (await h.read()).items[0]
  await h.manage({ action: 'forget', id: old.id })
  await h.manage({ action: 'create', text: '新事实' })
  await h.manage({ action: 'create', text: '稍后过期', expiresAt: START + 5 })
  await h.manage({ action: 'create', text: '另一个角色的经历', kind: 'episode', personaIdentity: 'other' })
  h.setTime(START + 10)
  const before = (await h.read()).revision
  await assert.rejects(h.state.exportLegacy(A, { personaIdentity: ID, expectedRevision: before, maxChars: 1 }), error => error.code === 'CAPACITY')
  assert.equal((await h.read()).revision, before)
  const result = await h.state.exportLegacy(A, { personaIdentity: ID, expectedRevision: before })
  assert.match(result.text, /新事实/)
  assert.doesNotMatch(result.text, /老事实|稍后过期|另一个角色/)
  await h.state.load(A, { legacyText: result.text })
  assert.notEqual((await h.read()).migration.legacyChanged, true)
  await h.state.load(A, { legacyText: result.text + '- 回滚时新增\n' })
  assert.equal((await h.read()).migration.legacyChanged, true)
  assert.equal((await h.read()).items.some(item => item.text === '回滚时新增'), false)
  await h.state.load(A, { legacyText: '' })
  assert.equal((await h.read()).migration.legacyChanged, true, 'rollback clearing a file is a change too')
})

test('corrupt files remain intact and storage failure cannot publish a changed in-memory value', async t => {
  const h = await setup(t)
  await h.manage({ action: 'create', text: '不能丢掉的旧值' })
  const folder = join(h.dir, 'conversation-state', 'v1')
  const file = join(folder, (await readdir(folder)).find(name => name.endsWith('.json')))
  const saved = await readFile(file, 'utf8')
  await rename(file, file + '.saved')
  await mkdir(file)
  const before = await h.read()
  await assert.rejects(h.manage({ action: 'create', text: '写失败的新值' }), error => error.code === 'STORAGE_ERROR')
  assert.deepEqual(await h.read(), before)
  await rm(file, { recursive: true })
  await writeFile(file, '{broken')
  const another = createConversationState({ dir: h.dir })
  t.after(() => another.dispose())
  await assert.rejects(another.load(A), error => error.code === 'STORAGE_ERROR')
  assert.equal(await readFile(file, 'utf8'), '{broken')
  assert.equal(await readFile(file + '.saved', 'utf8'), saved)
})

test('one host transaction commits independent logical turns once without borrowing their evidence', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true } })
  const expected = h.state.capture(A, ID)
  const batch = (id, key, body) => ({ personaIdentity: ID, turnId: id, expected,
    evidence: [h.ev(id)], operations: [{ type: 'fact', kind: 'preference', key, text: body,
      subjectId: 'alice', explicit: true, sourceIds: [id] }] })
  const first = batch('first', 'food', '喜欢香菜'), second = batch('second', 'length', '喜欢短句')
  second.operations.push({ type: 'habit', dimension: 'length', value: '一句话', subjectId: 'alice', explicit: true, sourceIds: ['second'] })
  const borrowed = batch('third', 'borrowed', '不能借用另一批的来源')
  borrowed.operations[0].sourceIds = ['first']
  const result = await h.state.applyProposalBatches(A, { batches: [first, second, borrowed] })
  assert.equal(result.applied, 3)
  assert.equal(result.rejected[0].batchIndex, 2)
  assert.equal(result.rejected[0].code, 'FORBIDDEN')
  const view = await h.read()
  assert.equal(view.revision, expected.revision + 1, 'one durable transaction for the host turn')
  assert.deepEqual(view.items.map(item => item.text).sort(), ['喜欢短句', '喜欢香菜'])
  assert.equal(view.habits[0].value, '一句话')
  const duplicate = await h.state.applyProposalBatches(A, { batches: [first, second] })
  assert.ok(duplicate.batches.every(item => item.duplicate))
  assert.equal((await h.read()).revision, view.revision)
})

test('batch transactions retain external-write conflicts and publish nothing on atomic storage failure', async t => {
  const h = await setup(t)
  await h.manage({ action: 'settings', learning: { enabled: true }, emotion: { enabled: true } })
  const make = (id, expected) => ({ personaIdentity: ID, turnId: id, expected, evidence: [h.ev(id)],
    operations: [{ type: 'fact', kind: 'preference', subjectId: 'alice', explicit: true, key: id, text: id, sourceIds: [id] }] })
  const stale = h.state.capture(A, ID)
  await h.manage({ action: 'create', text: '人工插入的记录' })
  const conflict = await h.state.applyProposalBatches(A, { batches: [make('old-a', stale), make('old-b', stale)] })
  assert.deepEqual(conflict.rejected.map(item => item.code), ['CONFLICT', 'CONFLICT'])
  assert.equal((await h.read()).total, 1)
  const before = await h.read(), expected = h.state.capture(A, ID)
  const folder = join(h.dir, 'conversation-state', 'v1')
  const file = join(folder, (await readdir(folder)).find(name => name.endsWith('.json')))
  await rename(file, file + '.saved')
  await mkdir(file)
  const first = make('new-a', expected), second = make('new-b', expected)
  second.operations.push({ type: 'mood', label: 'happy', intensity: 0.5, targetMemberId: 'alice', reason: '一起开玩笑', sourceIds: ['new-b'] })
  await assert.rejects(h.state.applyProposalBatches(A, { batches: [first, second] }), error => error.code === 'STORAGE_ERROR')
  assert.deepEqual(await h.read(), before, 'neither early facts nor staged mood escape a failed transaction')
  await rm(file, { recursive: true })
  await rename(file + '.saved', file)
  assert.equal((await h.state.applyProposalBatches(A, { batches: [first, second] })).applied, 3)
})

test('read-only inspection distinguishes initial migration failure from existing or forgotten state', async t => {
  const h = await setup(t)
  assert.deepEqual(await h.state.inspect(B), { exists: false, revision: 0, migrationVersion: 0, hasData: false, hasDeletionBoundary: false })
  assert.equal(h.state.summary(B).loaded, false)
  assert.deepEqual(await readdir(h.dir), [])
  await assert.rejects(h.state.load(A, { legacyText: '长'.repeat(2001) }))
  assert.equal((await h.state.inspect(A)).exists, false)
  await h.state.load(A, { legacyText: '- 不应在遗忘后恢复' })
  assert.equal((await h.state.inspect(A)).migrationVersion, 1)
  await h.manage({ action: 'forget', id: (await h.read()).items[0].id })
  const info = await h.state.inspect(A)
  assert.equal(info.exists, true)
  assert.equal(info.hasData, false)
  assert.equal(info.hasDeletionBoundary, true)
  const folder = join(h.dir, 'conversation-state', 'v1')
  const file = join(folder, (await readdir(folder)).find(name => name.endsWith('.json')))
  await writeFile(file, '{broken')
  await assert.rejects(h.state.inspect(A), error => error.code === 'STORAGE_ERROR')
  assert.equal(await readFile(file, 'utf8'), '{broken')
})
