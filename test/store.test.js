import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, MAX_PERSONA_STICKERS, normalizePersonaStickerIds } from '../lib/store.js'
import { createLogger } from './helpers/fake-ctx.js'

const tempDir = () => mkdtemp(join(tmpdir(), 'dsh-qq-store-'))

test('首次加载创建空状态，读写后落盘为合法 JSON', async () => {
  const dir = await tempDir()
  const store = createStore({ dir, logger: createLogger() })
  const loaded = await store.load()
  assert.deepEqual(loaded, { fresh: true, recovered: false })

  await store.setCurrentSession('qqbot:1:dm:u1', 'qq-session-1', { title: 'QQ dm:u1' })
  await store.setSelection('qqbot:1:dm:u1', { model: 'deepseek/chat', reasoning: 'high' })
  const chat = store.chat('qqbot:1:dm:u1')
  assert.equal(chat.currentSessionId, 'qq-session-1')
  assert.equal(chat.model, 'deepseek/chat')
  assert.equal(chat.sessions.length, 1)

  const raw = JSON.parse(await readFile(store.file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.chats['qqbot:1:dm:u1'].currentSessionId, 'qq-session-1')
})

test('重新加载恢复持久化状态', async () => {
  const dir = await tempDir()
  const first = createStore({ dir })
  await first.load()
  await first.setCurrentSession('qqbot:1:group:g1', 'qq-s1', { title: 'A' })
  await first.addAuthorized('user-9', { role: 'admin' })
  await first.setHomeChannel('user-9')

  const second = createStore({ dir })
  const loaded = await second.load()
  assert.equal(loaded.fresh, false)
  assert.equal(second.chat('qqbot:1:group:g1').currentSessionId, 'qq-s1')
  assert.equal(second.roleOf('user-9'), 'owner') // homeChannel 即 owner
  assert.equal(second.isAuthorized('user-9'), true)
  assert.equal(second.isAuthorized('stranger'), false)
})

test('损坏状态文件：备份 + 重建，不阻塞启动', async () => {
  const dir = await tempDir()
  const seed = createStore({ dir })
  await seed.load()
  await writeFile(seed.file, '{ this is not json', 'utf8')

  const logger = createLogger()
  const store = createStore({ dir, logger })
  const loaded = await store.load()
  assert.equal(loaded.recovered, true)
  assert.equal(loaded.fresh, true)
  assert.equal(store.stats().chats, 0)
  const files = await readdir(dir)
  assert.ok(files.some(name => name.includes('.corrupt-')), `expected corrupt backup, got ${files.join(',')}`)
  assert.ok(logger.entries.warn.some(line => line.includes('corrupted')))
})

test('会话列表：新增/排序/切换/上限', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  const chatKey = 'qqbot:1:dm:u1'
  for (let index = 1; index <= 12; index += 1) {
    await store.setCurrentSession(chatKey, `qq-s${index}`, { title: `S${index}`, at: 1000 + index })
  }
  const sessions = store.sessions(chatKey)
  assert.equal(sessions.length, 10, '最近会话上限 10')
  assert.equal(sessions[0].sessionId, 'qq-s12', '最新在前')
  const switched = await store.switchSession(chatKey, 2)
  assert.equal(switched.sessionId, sessions[2].sessionId)
  assert.equal(store.chat(chatKey).currentSessionId, sessions[2].sessionId)
  assert.equal(await store.switchSession(chatKey, 99), null)
})

test('并发写序列化：文件始终是合法 JSON 且包含最后一次写入', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  await Promise.all(
    Array.from({ length: 20 }, (_, index) => store.setCurrentSession('qqbot:1:dm:u1', `qq-x${index}`, { at: index })),
  )
  const raw = JSON.parse(await readFile(store.file, 'utf8'))
  assert.equal(typeof raw.chats['qqbot:1:dm:u1'].currentSessionId, 'string')
  const files = await readdir(dir)
  assert.ok(!files.includes('store.v1.json.tmp'), 'tmp 文件应已被 rename')
})

test('授权与配对状态机', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  assert.equal(store.roleOf('u1'), 'everyone')
  await store.addAuthorized('u1', { role: 'authorized' })
  assert.equal(store.roleOf('u1'), 'authorized')
  assert.equal(store.isAuthorized('u1'), true)
  await store.addAuthorized('u1', { role: 'admin' })
  assert.equal(store.roleOf('u1'), 'admin')

  const pending = await store.addPendingPairing({ userId: 'u2', name: 'Bob' })
  assert.equal(pending.id, 'u2')
  assert.equal(store.pendingPairing().length, 1)
  await store.addAuthorized('u2')
  assert.equal(store.pendingPairing().length, 0, '批准后清出待批列表')

  assert.equal(await store.removeAuthorized('u2'), true)
  assert.equal(store.roleOf('u2'), 'everyone')
  assert.deepEqual(store.stats(), { chats: 0, sessions: 0, authorized: 1, version: 1 })
})

test('chat 状态形状修复：缺字段的旧数据可加载', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  await writeFile(
    store.file,
    JSON.stringify({ version: 1, chats: { 'k': { currentSessionId: 's1' }, broken: 42 }, pairing: {}, meta: {} }),
    'utf8',
  )
  const reloaded = createStore({ dir })
  const result = await reloaded.load()
  assert.equal(result.recovered, false)
  assert.deepEqual(reloaded.chat('k').sessions, [])
  assert.deepEqual(reloaded.chat('broken').sessions, [])
  assert.equal(reloaded.chat('k').currentSessionId, 's1')
})

test('身份按 transport 隔离：一条线的主人不会在另一条线上被当成主人', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-store-id-'))
  const store = createStore({ dir })
  await store.load()

  // 示例场景：个人线的 QQ 号 100004 是主人；官方线的 openid 是另一个人
  await store.setHomeChannel('100004', 'onebot')
  await store.setHomeChannel('EXAMPLE_OPENID', 'qqbot')

  assert.equal(store.roleOf('100004', 'onebot'), 'owner')
  assert.equal(store.roleOf('EXAMPLE_OPENID', 'qqbot'), 'owner')
  // 关键回归：拿个人线的主人在官方线上判角色 → 不是主人（修复前这里是 owner，导致「我不就是管理？」被判陌生人/反过来也行不通）
  assert.equal(store.roleOf('100004', 'qqbot'), 'everyone')
  assert.equal(store.roleOf('EXAMPLE_OPENID', 'onebot'), 'everyone')
})

test('身份隔离：授权记录带 transport 前缀，只对来源线生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-store-auth-'))
  const store = createStore({ dir })
  await store.load()
  await store.addAuthorized('100005', { role: 'authorized', transportKind: 'onebot' })

  assert.equal(store.roleOf('100005', 'onebot'), 'authorized')
  assert.equal(store.roleOf('100005', 'qqbot'), 'everyone')
  assert.deepEqual(store.authorizedList('onebot'), [{ id: '100005', role: 'authorized' }])
  assert.deepEqual(store.authorizedList('qqbot'), [])
  assert.equal(await store.removeAuthorized('100005', 'onebot'), true)
  assert.equal(store.roleOf('100005', 'onebot'), 'everyone')
})

test('旧数据迁移：无前缀的 homeChannel/roles 按 id 形态归到 onebot/qqbot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-store-mig-'))
  // 模拟旧版 store：全局 homeChannel=QQ号，roles 也是裸 id
  await writeFile(
    join(dir, 'store.v1.json'),
    JSON.stringify({
      version: 1,
      chats: {},
      pairing: { policy: 'pairing', roles: { '100005': 'authorized', EXAMPLE_OPENID: 'authorized' }, pending: [] },
      meta: { homeChannel: '100004', accountId: '', updatedAt: 0 },
    }),
    'utf8',
  )
  const store = createStore({ dir })
  await store.load()

  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.meta.homeChannels, { onebot: '100004' })
  assert.equal(snapshot.pairing.roles['onebot:100005'], 'authorized', '纯数字归 onebot')
  assert.equal(snapshot.pairing.roles['qqbot:EXAMPLE_OPENID'], 'authorized', 'openid 归 qqbot')
  assert.equal(snapshot.pairing.roles['100005'], undefined, '旧的无前缀记录要迁走')
  assert.equal(store.roleOf('100004', 'onebot'), 'owner')
  assert.equal(store.roleOf('EXAMPLE_OPENID', 'qqbot'), 'authorized')
})

test('活动计数：按天按线路累加、近 7 天补零、重启后不丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-activity-'))
  const store = createStore({ dir })
  await store.load()

  await store.recordActivity('qqbot')
  await store.recordActivity('onebot')
  await store.recordActivity('onebot')
  await store.recordActivity('')  // 空 kind 忽略

  const series = store.activity(7)
  assert.equal(series.length, 7)
  const today = series.at(-1)
  assert.equal(typeof today.date, 'string')
  assert.equal(today.qqbot, 1)
  assert.equal(today.onebot, 2)
  assert.equal(series[0].qqbot, 0, '没有活动的历史天补 0')

  // 重启后仍在
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.deepEqual(reloaded.activity(7).at(-1), today)
})

test('活动计数：超过保留天数的旧记录在写入时被裁掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-activity-prune-'))
  const old = new Date(Date.now() - 60 * 86400_000)
  const pad = value => String(value).padStart(2, '0')
  const oldKey = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`
  await writeFile(join(dir, 'store.v1.json'), JSON.stringify({ version: 1, chats: {}, pairing: { policy: 'pairing', roles: {}, pending: [] }, meta: {}, activity: { [oldKey]: { qqbot: 5 } } }), 'utf8')
  const store = createStore({ dir })
  await store.load()
  for (let index = 0; index < 40; index += 1) await store.recordActivity('qqbot')
  assert.equal(store.snapshot().activity[oldKey], undefined, '60 天前的记录应被裁掉')
  assert.ok(store.snapshot().activity[Object.keys(store.snapshot().activity)[0]].qqbot >= 1)
})

// ── token 用量：按对话/按天记账 + 30 天报表 ──

test('token 用量：按对话按天累计，报表给出今日/近7天/近30天合计与排序', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-usage-'))
  const store = createStore({ dir })
  await store.load()

  await store.recordUsage('qqbot:100001:dm:user-a', { inputTokens: 100, outputTokens: 40, totalTokens: 140 })
  await store.recordUsage('qqbot:100001:dm:user-a', { inputTokens: 10, outputTokens: 5 })
  await store.recordUsage('onebot:100002:group:100003', { promptTokens: 200, completionTokens: 50 })
  assert.equal(await store.recordUsage('', { totalTokens: 1 }), null, '空 chatKey 忽略')
  assert.equal(await store.recordUsage('qqbot:x', {}), null, '没有用量的 usage 忽略')

  const report = store.usageReport({ days: 30 })
  assert.equal(report.span, 30)
  assert.equal(report.days.length, 30, '固定 30 天序列')
  assert.deepEqual(report.totals.today, { total: 405, input: 310, output: 95, turns: 3 })
  assert.equal(report.totals.week.total, 405, '只用今天的数据时 7 天 = 今天')
  assert.equal(report.totals.month.total, 405)
  assert.deepEqual(report.chats.map(row => row.chatKey), [
    'onebot:100002:group:100003',
    'qqbot:100001:dm:user-a',
  ], '按总消耗降序')
  assert.equal(report.chats[1].turns, 2)
  assert.equal(report.chats[0].days[report.days.at(-1).date].total, 250)

  // 重启后不丢
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.usageReport({ days: 30 }).totals.today.total, 405)
})

test('token 用量：超过保留天数的旧记录在写入时裁掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-usage-prune-'))
  const old = new Date(Date.now() - 60 * 86400_000)
  const pad = value => String(value).padStart(2, '0')
  const oldKey = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`
  await writeFile(join(dir, 'store.v1.json'), JSON.stringify({
    version: 1,
    chats: {},
    pairing: { policy: 'pairing', roles: {}, pending: [] },
    meta: {},
    usage: { [oldKey]: { 'qqbot:1:dm:u': { in: 10, out: 5, total: 15, turns: 1 } } },
  }), 'utf8')
  const store = createStore({ dir })
  await store.load()
  for (let index = 0; index < 40; index += 1) {
    await store.recordUsage('qqbot:100001:dm:user-a', { totalTokens: 1 })
  }
  assert.equal(store.snapshot().usage[oldKey], undefined, '60 天前的用量应被裁掉')
})

test('normalizeUsageNumbers：兼容不同字段名，缺 total 时用输入+输出', async () => {
  const { normalizeUsageNumbers } = await import('../lib/store.js')
  assert.deepEqual(normalizeUsageNumbers({ inputTokens: 3, outputTokens: 4 }), { input: 3, output: 4, total: 7 })
  assert.deepEqual(normalizeUsageNumbers({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 12 }), { input: 5, output: 6, total: 12 })
  assert.equal(normalizeUsageNumbers({}), null)
  assert.equal(normalizeUsageNumbers(null), null)
})

// ── 审批历史：只留决策元数据，最多 50 条，重启不丢 ──

test('审批历史：记录允许/拒绝，非法决策忽略，容量封顶 50', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-approvals-'))
  const store = createStore({ dir })
  await store.load()
  assert.deepEqual(store.approvalsRecent(), [])

  await store.recordApproval({ at: 1000, chatKey: 'qqbot:1:dm:u1', decision: 'allow', actorId: 'owner', summary: '运行 rm', approvalId: 'ap-1' })
  await store.recordApproval({ decision: 'deny', summary: '拒绝执行' })
  assert.equal(await store.recordApproval({ decision: 'maybe' }), null, '非法决策忽略')
  const rows = store.approvalsRecent()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].decision, 'deny', '最新的在前')
  assert.equal(rows[1].actorId, 'owner')

  for (let index = 0; index < 60; index += 1) {
    await store.recordApproval({ decision: 'allow', summary: `第 ${index} 条` })
  }
  assert.equal(store.approvalsRecent(100).length, 50, '最多 50 条')

  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.approvalsRecent(100).length, 50)
  assert.equal(reloaded.approvalsRecent()[0].summary, '第 59 条')
})

// ── 微批写：并发 save 合并，flushSave 立即刷盘 ──

test('微批写：并发记录合并落盘；flushSave 可立即刷盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-batch-'))
  const store = createStore({ dir })
  await store.load()
  await Promise.all(Array.from({ length: 20 }, () => store.recordActivity('qqbot')))
  assert.equal(store.activity(1).at(-1).qqbot, 20, '内存计数正确')

  // await 返回时同一批已经落盘：新实例能读到
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.activity(1).at(-1).qqbot, 20)

  await store.setHomeChannel('owner-x', 'qqbot')
  await store.flushSave()
  const third = createStore({ dir })
  await third.load()
  assert.equal(third.homeChannel('qqbot'), 'owner-x', 'flushSave 必须立即刷盘')
})

// ── 会话 system prompt：默认 + 按对话覆盖 ──

test('会话提示词：默认/按对话覆盖/清除/长度上限/重启不丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-prompt-'))
  const store = createStore({ dir })
  await store.load()
  assert.equal(store.defaultPrompt(), '')
  assert.equal(store.promptFor('onebot:1:group:2'), '')
  assert.deepEqual(store.promptChats(), {})

  await store.setDefaultPrompt('你是群助手，回答简短。')
  assert.equal(store.promptFor('onebot:1:group:2'), '你是群助手，回答简短。')
  await store.setChatPrompt('onebot:1:group:2', '这个群只聊技术。')
  assert.equal(store.promptFor('onebot:1:group:2'), '这个群只聊技术。', '对话覆盖优先于默认')
  assert.equal(store.promptFor('onebot:1:dm:9'), '你是群助手，回答简短。', '其它对话回落到默认')
  assert.deepEqual(store.promptChats(), { 'onebot:1:group:2': '这个群只聊技术。' })

  // 空文本 = 清除覆盖
  await store.setChatPrompt('onebot:1:group:2', '')
  assert.equal(store.promptFor('onebot:1:group:2'), '你是群助手，回答简短。')
  assert.deepEqual(store.promptChats(), {})

  await store.setDefaultPrompt('x'.repeat(5000))
  await store.setChatPrompt('onebot:1:group:2', 'x'.repeat(5000))
  await assert.rejects(() => store.setDefaultPrompt('x'.repeat(5001)), /太长/)
  await assert.rejects(() => store.setChatPrompt('onebot:1:group:2', 'x'.repeat(5001)), /太长/)
  await assert.rejects(() => store.setChatPrompt('', 'x'), /不能为空/)

  await store.setChatPrompt('onebot:1:group:2', '持久化')
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.defaultPrompt(), 'x'.repeat(5000))
  assert.equal(reloaded.promptFor('onebot:1:group:2'), '持久化')
})

// ── 命名人设库 + 对话绑定 ──

test('人设详情与保存返回完整 id，旧落盘格式重载后保留数字编号的前导零', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  const saved = await store.setPersona(' 002 ', { name: '测试人设', text: '临时测试内容。' })
  assert.equal(saved.id, '002')
  assert.deepEqual(store.personaOf('002'), saved)
  saved.id = 'other'
  saved.text = '修改返回对象不能修改已保存内容'
  assert.equal(store.personaOf('002').id, '002')
  assert.equal(store.personaOf('002').text, '临时测试内容。')
  const raw = JSON.parse(await readFile(store.file, 'utf8'))
  assert.equal(Object.hasOwn(raw.personas['002'], 'id'), false, '不向原有落盘记录重复写入 id')
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.personaOf('002').id, '002')
  assert.equal(reloaded.personaOf('002').name, '测试人设')
  assert.equal(reloaded.personaOf('missing'), null)
})

test('人设库：保存/默认/绑定/解绑，生效来源可追踪', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-persona-'))
  const store = createStore({ dir })
  await store.load()
  const chatKey = 'qqbot:1:group:g1'

  await store.setPersona('tech', { name: '技术顾问', text: '你只聊技术。' })
  await store.setPersona('cute', { name: '可爱助手', text: '说话可爱一点。' })
  assert.equal(store.personaList().length, 2)
  assert.equal(store.effectivePromptFor(chatKey).source, 'none')

  await store.setDefaultPersona('tech')
  assert.deepEqual(store.effectivePromptFor(chatKey), {
    text: '你只聊技术。',
    source: 'defaultPersona',
    personaId: 'tech',
    personaName: '技术顾问',
    stickerIds: [],
    aliases: [],
    activity: 'inherit',
  })

  await store.bindPersona(chatKey, 'cute')
  assert.equal(store.personaBinding(chatKey), 'cute')
  assert.equal(store.effectivePromptFor(chatKey).text, '说话可爱一点。')
  assert.equal(store.effectivePromptFor(chatKey).source, 'binding')

  // 旧对话提示词写入会清绑定；绑定会清旧对话提示词
  await store.setChatPrompt(chatKey, '这是旧覆盖。')
  assert.equal(store.personaBinding(chatKey), '', '显式写对话提示词应解除人设绑定')
  assert.equal(store.effectivePromptFor(chatKey).source, 'chat')

  await store.bindPersona(chatKey, 'tech')
  assert.equal(store.chatPrompt(chatKey), '', '绑定人设应清掉旧对话提示词')
  assert.equal(store.effectivePromptFor(chatKey).source, 'binding')

  // 删除人设会清默认引用与绑定
  assert.equal(await store.removePersona('tech'), true)
  assert.equal(store.defaultPersonaId(), '')
  assert.equal(store.personaBinding(chatKey), '')
  assert.equal(store.effectivePromptFor(chatKey).source, 'none')
})

test('人设精选：保存去重、省略保留、显式清空，非法输入不覆盖已有选择', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  const saved = await store.setPersona('fish', { text: '测试人设', stickerIds: [ids[0], ids[0], ids[1]] })
  assert.deepEqual(saved.stickerIds, ids)
  assert.equal(store.personaList()[0].stickerCount, 2)
  saved.stickerIds.pop()
  assert.deepEqual(store.personaOf('fish').stickerIds, ids, '调用方修改返回数组不影响保存内容')
  await store.setPersona('fish', { name: '新名称', text: '只改文字' })
  assert.deepEqual(store.personaOf('fish').stickerIds, ids, '旧调用不传新字段时保留精选')
  const revision = store.promptRevision()
  for (const stickerIds of [null, 'not-an-array', [1], ['invalid'], ['A'.repeat(64)]]) {
    await assert.rejects(() => store.setPersona('fish', { text: '不得保存', stickerIds }), /精选表情/)
  }
  const tooMany = Array.from({ length: MAX_PERSONA_STICKERS + 1 }, (_, index) => index.toString(16).padStart(64, '0'))
  await assert.rejects(() => store.setPersona('fish', { text: '不得保存', stickerIds: tooMany }), /最多精选 40/)
  assert.equal(store.promptRevision(), revision)
  assert.deepEqual(store.personaOf('fish').stickerIds, ids)
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.deepEqual(reloaded.personaOf('fish').stickerIds, ids)
  await reloaded.setPersona('fish', { text: '保留人设、清空精选', stickerIds: [] })
  assert.deepEqual(reloaded.personaOf('fish').stickerIds, [])
  assert.equal(reloaded.personaList()[0].stickerCount, 0)
})

test('人设精选迁移：旧记录补空数组，坏项去重过滤、有界保留未知图库 ID', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  const ids = Array.from({ length: 45 }, (_, index) => index.toString(16).padStart(64, '0'))
  await writeFile(store.file, JSON.stringify({ version: 1, chats: {}, personas: {
    old: { name: '旧人设', text: '没有精选字段' },
    fish: { name: '测试人设', text: '迁移精选', stickerIds: ['invalid', ids[0], ...ids, null] },
  } }))
  await store.load()
  assert.deepEqual(store.personaOf('old').stickerIds, [])
  assert.equal(store.personaList().find(item => item.id === 'old').stickerCount, 0)
  assert.deepEqual(store.personaOf('fish').stickerIds, ids.slice(0, MAX_PERSONA_STICKERS))
  assert.deepEqual(normalizePersonaStickerIds([ids[0], ids[0]], { strict: true }), [ids[0]])
  assert.throws(() => normalizePersonaStickerIds(['invalid'], { strict: true }), /精选表情/)
})

test('生效人设的精选跟随默认、模式绑定和旧提示词优先级，返回数组相互隔离', async () => {
  const store = createStore({ dir: await tempDir() })
  await store.load()
  const key = 'qqbot:1:group:100'
  const workId = 'a'.repeat(64), chatId = 'b'.repeat(64)
  await store.setPersona('work', { text: '工作', stickerIds: [workId] })
  await store.setPersona('chat', { text: '聊天', stickerIds: [chatId] })
  await store.setDefaultPersona('work')
  assert.deepEqual(store.effectivePromptFor(key, 'chat').stickerIds, [workId])
  await store.setChatPrompt(key, '旧提示词覆盖默认人设')
  assert.deepEqual(store.effectivePromptFor(key, 'chat').stickerIds ?? [], [])
  await store.bindPersona(key, 'work', 'work')
  await store.bindPersona(key, 'chat', 'chat')
  assert.deepEqual(store.effectivePromptFor(key, 'work').stickerIds, [workId])
  const effective = store.effectivePromptFor(key, 'chat')
  assert.deepEqual(effective.stickerIds, [chatId])
  effective.stickerIds.length = 0
  assert.deepEqual(store.personaOf('chat').stickerIds, [chatId])
})

test('人设库：id/空文本/超长校验，非法数据在加载时被丢弃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-persona-invalid-'))
  const store = createStore({ dir })
  await store.load()
  await assert.rejects(() => store.setPersona('Bad ID', { text: 'x' }), /人设 id/)
  await assert.rejects(() => store.setPersona('ok', { text: '   ' }), /不能为空/)
  await store.setPersona('ok', { text: 'x'.repeat(5000) })
  await assert.rejects(() => store.setPersona('ok', { text: 'x'.repeat(5001) }), /人设太长/)
  await assert.rejects(() => store.setDefaultPersona('missing'), /人设不存在/)

  await writeFile(store.file, JSON.stringify({
    version: 1,
    chats: {},
    pairing: { policy: 'pairing', roles: {}, pending: [] },
    meta: {},
    activity: {},
    usage: {},
    approvals: [],
    prompt: { default: '', chats: {} },
    personas: {
      good: { name: 'G', text: 'hi', updatedAt: 1 },
      'Bad ID': { name: 'B', text: 'x' },
      empty: { name: 'E', text: '   ' },
    },
    defaultPersonaId: 'missing',
    personaBindings: { 'qqbot:1:dm:u': { personaId: 'missing' }, 'qqbot:1:dm:v': { personaId: 'good' } },
  }, null, 2), 'utf8')
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.deepEqual(reloaded.personaList().map(item => item.id), ['good'])
  assert.equal(reloaded.defaultPersonaId(), '')
  assert.deepEqual(Object.keys(reloaded.personaModeBindings()), ['qqbot:1:dm:v'])
  assert.equal(reloaded.personaBinding('qqbot:1:dm:v', 'work'), 'good')
  assert.equal(reloaded.personaBinding('qqbot:1:dm:v', 'chat'), '')
})

test('人设库：跨重启保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-persona-reload-'))
  const first = createStore({ dir })
  await first.load()
  await first.setPersona('tech', { name: '技术', text: '只聊技术' })
  await first.setDefaultPersona('tech')
  await first.bindPersona('qqbot:1:dm:u', 'tech')

  const second = createStore({ dir })
  await second.load()
  assert.equal(second.effectivePromptFor('qqbot:1:dm:u').text, '只聊技术')
  assert.equal(second.defaultPersonaId(), 'tech')
})

test('对话模式：默认 work，切换 chat 后跨重启保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-mode-'))
  const first = createStore({ dir })
  await first.load()
  assert.equal(first.modeFor('qqbot:1:dm:u'), 'work')
  await first.setMode('qqbot:1:dm:u', 'chat')
  assert.equal(first.modeFor('qqbot:1:dm:u'), 'chat')
  await assert.rejects(() => first.setMode('qqbot:1:dm:u', 'nope'), /mode must be work or chat/)

  const second = createStore({ dir })
  await second.load()
  assert.equal(second.modeFor('qqbot:1:dm:u'), 'chat')
  assert.equal(second.modeFor('qqbot:1:dm:other'), 'work')
})

test('模式会话：work/chat 各自指针，过滤会话列表并跨重启保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-mode-session-'))
  const first = createStore({ dir })
  await first.load()
  const chatKey = 'qqbot:1:dm:u'
  await first.setCurrentSession(chatKey, 's-work', { mode: 'work' })
  await first.setMode(chatKey, 'chat')
  await first.setCurrentSession(chatKey, 's-chat', { mode: 'chat' })
  assert.equal(first.modeSession(chatKey, 'work'), 's-work')
  assert.equal(first.modeSession(chatKey, 'chat'), 's-chat')
  assert.equal(first.sessionMode(chatKey, 's-work'), 'work')
  assert.deepEqual(first.sessions(chatKey, 'work').map(item => item.sessionId), ['s-work'])
  assert.deepEqual(first.sessions(chatKey, 'chat').map(item => item.sessionId), ['s-chat'])

  const second = createStore({ dir })
  await second.load()
  assert.equal(second.modeFor(chatKey), 'chat')
  assert.equal(second.modeSession(chatKey, 'work'), 's-work')
  assert.equal(second.modeSession(chatKey, 'chat'), 's-chat')
  assert.equal(second.chat(chatKey).currentSessionId, 's-chat')
})

test('人设按模式绑定：work/chat 各自生效，互不覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-persona-mode-'))
  const s = createStore({ dir })
  await s.load()
  await s.setPersona('tech', { name: '技术', text: '工作模式：只聊技术' })
  await s.setPersona('cute', { name: '可爱', text: '聊天模式：可爱一点' })
  const chatKey = 'qqbot:1:dm:u'
  await s.setMode(chatKey, 'work')
  await s.bindPersona(chatKey, 'tech', 'work')
  await s.setMode(chatKey, 'chat')
  await s.bindPersona(chatKey, 'cute', 'chat')
  assert.equal(s.effectivePromptFor(chatKey, 'work').text, '工作模式：只聊技术')
  assert.equal(s.effectivePromptFor(chatKey, 'chat').text, '聊天模式：可爱一点')
  assert.equal(s.effectivePromptFor(chatKey).text, '聊天模式：可爱一点', '不传 mode 用当前模式')
  assert.equal(s.personaBinding(chatKey, 'work'), 'tech')
  assert.equal(s.personaBinding(chatKey, 'chat'), 'cute')

  const reopened = createStore({ dir })
  await reopened.load()
  assert.equal(reopened.effectivePromptFor(chatKey, 'work').text, '工作模式：只聊技术')
  assert.equal(reopened.effectivePromptFor(chatKey, 'chat').text, '聊天模式：可爱一点')
})

test('人设最近使用/收藏：记录、切换、删除清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-persona-recent-'))
  const s = createStore({ dir })
  await s.load()
  await s.setPersona('tech', { name: '技术', text: '技术' })
  await s.setPersona('cute', { name: '可爱', text: '可爱' })
  const key = 'qqbot:1:dm:u'
  await s.bindPersona(key, 'tech', 'work')
  await s.bindPersona(key, 'cute', 'chat')
  assert.deepEqual(s.personaRecentList(), ['cute', 'tech'])
  assert.equal(await s.togglePersonaFavorite('tech'), true)
  assert.deepEqual(s.personaFavoriteList(), ['tech'])
  assert.equal(await s.togglePersonaFavorite('tech'), false)
  assert.deepEqual(s.personaFavoriteList(), [])
  await s.togglePersonaFavorite('tech')
  await s.removePersona('tech')
  assert.deepEqual(s.personaFavoriteList(), [])
  assert.deepEqual(s.personaRecentList(), ['cute'])
})

test('定时任务：增删查、跨重启保留、非法条目加载时丢弃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-schedules-'))
  const first = createStore({ dir })
  await first.load()
  const task = {
    id: 's1', chatKey: 'qqbot:1:group:2', transportKind: 'qqbot', accountId: '1',
    target: { kind: 'group', groupId: '2' }, prompt: '早安', kind: 'daily', time: '09:00',
    at: null, enabled: true, social: false, createdAt: 1, lastRun: '', lastError: '',
  }
  await first.scheduleAdd(task)
  assert.equal(first.schedules().length, 1)
  await first.scheduleMark('s1', { lastRun: '2026-10-25', lastError: 'x' })
  assert.equal(first.schedules()[0].lastRun, '2026-10-25')
  assert.equal(first.schedules()[0].lastError, 'x')
  await assert.rejects(() => first.scheduleAdd({ ...task, id: 's1' }), /id 重复/)

  const second = createStore({ dir })
  await second.load()
  assert.equal(second.schedules().length, 1)
  assert.equal(second.schedules()[0].prompt, '早安')
  assert.equal(await second.scheduleRemove('s1'), true)
  assert.equal(second.schedules().length, 0)
})

test('明确偏好/静默：对话暂停、表情开关、成员称呼/主动暂停', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-prefs-'))
  const s = createStore({ dir })
  await s.load()
  const chatKey = 'qqbot:1:group:2'
  assert.deepEqual(s.chatPreference(chatKey), { proactiveUntil: 0, stickers: true, activity: 'inherit' })
  await s.setChatPreference(chatKey, { proactiveUntil: 123456, stickers: false })
  assert.equal(s.chatPreference(chatKey).proactiveUntil, 123456)
  assert.equal(s.chatPreference(chatKey).stickers, false)
  await s.setMemberPreference(chatKey, 'u1', { name: '小林', proactiveUntil: 999 })
  assert.deepEqual(s.memberPreference(chatKey, 'u1'), { name: '小林', proactiveUntil: 999 })
  await s.setMemberPreference(chatKey, 'u1', { name: '', proactiveUntil: 0 })
  assert.deepEqual(s.memberPreference(chatKey, 'u1'), { name: '', proactiveUntil: 0 })

  const reopened = createStore({ dir })
  await reopened.load()
  assert.equal(reopened.chatPreference(chatKey).stickers, false)
})


test('人设昵称与活跃档位：旧更新保留新字段，严格写入不部分修改，重载兼容', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  const saved = await store.setPersona('fish', { text: '日常聊天', aliases: [' 鱼鱼 ', '鱼鱼', '大肥鱼'], activity: 'active' })
  assert.deepEqual(saved.aliases, ['鱼鱼', '大肥鱼'])
  saved.aliases.push('外部篡改')
  await store.setPersona('fish', { text: '更新文案' })
  assert.deepEqual(store.personaOf('fish').aliases, ['鱼鱼', '大肥鱼'])
  assert.equal(store.personaOf('fish').activity, 'active')
  const before = store.personaOf('fish')
  for (const patch of [{ aliases: '鱼鱼' }, { aliases: ['鱼'] }, { aliases: ['鱼\n鱼'] }, { activity: null }, { activity: 'very-active' }]) {
    await assert.rejects(store.setPersona('fish', { text: '不能写入', ...patch }))
    assert.deepEqual(store.personaOf('fish'), before)
  }
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.deepEqual(reloaded.personaOf('fish'), before)
  await reloaded.setPersona('fish', { text: '重置', aliases: [], activity: 'inherit' })
  assert.deepEqual(reloaded.personaOf('fish').aliases, [])
  assert.equal(reloaded.personaOf('fish').activity, 'inherit')
})

test('生效行为按群覆盖/生效人设/全局继承解析，草稿预演完全只读', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await store.load()
  const key = 'onebot:1:group:g1', other = 'onebot:1:group:g2'
  await store.setPersona('global', { text: '默认', aliases: ['小鱼'], activity: 'quiet' })
  await store.setPersona('fish', { text: '群人设', aliases: ['鱼鱼'], activity: 'active' })
  await store.setDefaultPersona('global')
  await store.bindPersona(key, 'fish', 'chat')
  assert.deepEqual(store.effectiveBehaviorFor(key), { aliases: ['鱼鱼'], activity: 'active', source: 'persona' })
  assert.deepEqual(store.effectiveBehaviorFor(key, 'work'), { aliases: ['小鱼'], activity: 'quiet', source: 'persona' })
  await store.setChatPreference(key, { activity: 'normal' })
  const revision = store.promptRevision()
  await store.setChatPreference(key, { stickers: false })
  assert.equal(store.promptRevision(), revision, '其他偏好更新不变更活跃档位')
  assert.deepEqual(store.effectiveBehaviorFor(key), { aliases: ['鱼鱼'], activity: 'normal', source: 'chat' })
  assert.deepEqual(store.effectiveBehaviorFor(other), { aliases: ['小鱼'], activity: 'quiet', source: 'persona' })
  const snapshot = store.snapshot()
  const draft = { aliases: [' 草稿鱼 ', '草稿鱼'], activity: 'active' }
  assert.deepEqual(store.effectiveBehaviorFor(key, 'chat', { persona: draft }), { aliases: ['草稿鱼'], activity: 'normal', source: 'chat' })
  const preview = store.effectiveBehaviorFor('onebot:1:group:unknown', 'chat', { persona: draft })
  assert.deepEqual(preview, { aliases: ['草稿鱼'], activity: 'active', source: 'persona' })
  preview.aliases.push('修改副本')
  assert.deepEqual(store.snapshot(), snapshot)
  await assert.rejects(store.setChatPreference(key, { stickers: true, activity: 'bad' }), /档位/)
  assert.deepEqual(store.snapshot(), snapshot, '非法patch不能连带改变表情开关')
  await store.setChatPreference(key, { activity: 'inherit' })
  assert.deepEqual(store.effectiveBehaviorFor(key), { aliases: ['鱼鱼'], activity: 'active', source: 'persona' })
  await store.setChatPrompt(key, '旧文本覆盖，无命名人设')
  assert.deepEqual(store.effectiveBehaviorFor(key), { aliases: [], activity: 'inherit', source: 'global' })
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.chatPreference(key).activity, 'inherit')
})

test('旧存档未写行为字段时继承；非法历史昵称清理而不阻止启动', async () => {
  const dir = await tempDir()
  const store = createStore({ dir })
  await writeFile(store.file, JSON.stringify({ version: 1, chats: {}, personas: {
    old: { text: '旧人设' }, bad: { text: '有损字段', aliases: [' 鱼鱼 ', null, '鱼', '鱼\n鱼'], activity: 'bad' },
  }, preferences: { chats: { g1: { stickers: false }, g2: { activity: 'bad' } } } }))
  await store.load()
  assert.deepEqual(store.personaOf('old').aliases, [])
  assert.equal(store.personaOf('old').activity, 'inherit')
  assert.deepEqual(store.personaOf('bad').aliases, ['鱼鱼'])
  assert.equal(store.personaOf('bad').activity, 'inherit')
  assert.deepEqual(store.chatPreference('g1'), { proactiveUntil: 0, stickers: false, activity: 'inherit' })
  assert.equal(store.chatPreference('g2').activity, 'inherit')
})

test('局部prompt revision：无关群/未绑定人设不变，生效改动及ABA均失效', async () => {
  const store = createStore({ dir: await tempDir() })
  await store.load()
  const a = 'qqbot:bot:group:a', b = 'qqbot:bot:group:b'
  await store.setPersona('fish', { text: '简短回答' })
  await store.bindPersona(a, 'fish', 'chat')
  const a1 = store.promptRevision(a, 'chat'), b1 = store.promptRevision(b, 'chat')
  await store.setPersona('unused', { text: '无关角色' })
  assert.equal(store.promptRevision(a, 'chat'), a1)
  await store.setPersona('fish', { text: '详细回答' })
  await store.setPersona('fish', { text: '简短回答' })
  assert.ok(store.promptRevision(a, 'chat') > a1, '回到相同文本也不能复活旧草稿')
  assert.equal(store.promptRevision(b, 'chat'), b1)
  const work = store.promptRevision(a, 'work')
  await store.clearPersonaBinding(a, 'chat')
  assert.equal(store.promptRevision(a, 'work'), work)
})

test('会话绑定：持久化身份和contextEpoch，旧身份与遗忘前会话不可恢复', async () => {
  const dir = await tempDir(), key = 'qqbot:bot:group:g'
  const store = createStore({ dir })
  await store.load()
  await store.setMode(key, 'chat')
  await store.setCurrentSession(key, 's1', { mode: 'chat', personaIdentity: 'fish', contextEpoch: 2 })
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.sessionRestorable(key, 's1', { mode: 'chat', personaIdentity: 'fish', minContextEpoch: 2 }), true)
  assert.equal(reloaded.sessionRestorable(key, 's1', { mode: 'chat', personaIdentity: 'other' }), false)
  assert.equal(reloaded.sessionRestorable(key, 's1', { mode: 'chat', personaIdentity: 'fish', minContextEpoch: 3 }), false)
  await reloaded.clearCurrentSession(key, 'chat')
  assert.equal(reloaded.modeSession(key, 'chat'), '')
  assert.equal(reloaded.sessions(key, 'chat').length, 1, '历史留作查看')
  await reloaded.setPersona('none', { text: '合法的同名卡' })
  assert.equal(reloaded.personaIdentityFor(key, 'chat'), 'legacy:none')
  await reloaded.bindPersona(key, 'none', 'chat')
  assert.equal(reloaded.personaIdentityFor(key, 'chat'), 'none')
})

test('删除人设后同ID重建不能复活历史会话绑定', async () => {
  const dir = await tempDir(), key = 'qqbot:bot:group:g'
  const store = createStore({ dir })
  await store.load()
  await store.setPersona('fish', { text: '旧角色' })
  await store.setCurrentSession(key, 'old', { mode: 'chat', personaIdentity: 'fish', contextEpoch: 0 })
  await store.removePersona('fish')
  await store.setPersona('fish', { text: '新角色' })
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.sessionRestorable(key, 'old', { mode: 'chat', personaIdentity: 'fish' }), false)
})

test('promptMaxChars：按传入上限校验，降低配置不截断旧正文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-prompt-limit-'))
  const wide = createStore({ dir, maxPromptChars: 6000 })
  await wide.load()
  await wide.setPersona('wide', { text: 'x'.repeat(6000) })
  assert.equal(wide.personaOf('wide').text.length, 6000)
  await assert.rejects(() => wide.setPersona('too-long', { text: 'x'.repeat(6001) }), /6000/)

  const narrow = createStore({ dir, maxPromptChars: 5000 })
  await narrow.load()
  assert.equal(narrow.personaOf('wide').text.length, 6000, '降低上限不应在读取时截断旧正文')
  await assert.rejects(() => narrow.setPersona('wide', { text: 'x'.repeat(6000) }), /5000/)
})
