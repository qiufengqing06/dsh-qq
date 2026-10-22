import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
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

  // 真机场景：个人线的 QQ 号 3298364424 是主人；官方线的 openid 是另一个人
  await store.setHomeChannel('3298364424', 'mock')
  await store.setHomeChannel('A6AB252127520117332879C06EE346AC', 'qqbot')

  assert.equal(store.roleOf('3298364424', 'mock'), 'owner')
  assert.equal(store.roleOf('A6AB252127520117332879C06EE346AC', 'qqbot'), 'owner')
  // 关键回归：拿个人线的主人在官方线上判角色 → 不是主人（修复前这里是 owner，导致「我不就是管理？」被判陌生人/反过来也行不通）
  assert.equal(store.roleOf('3298364424', 'qqbot'), 'everyone')
  assert.equal(store.roleOf('A6AB252127520117332879C06EE346AC', 'mock'), 'everyone')
})

test('身份隔离：授权记录带 transport 前缀，只对来源线生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-store-auth-'))
  const store = createStore({ dir })
  await store.load()
  await store.addAuthorized('2081371760', { role: 'authorized', transportKind: 'mock' })

  assert.equal(store.roleOf('2081371760', 'mock'), 'authorized')
  assert.equal(store.roleOf('2081371760', 'qqbot'), 'everyone')
  assert.deepEqual(store.authorizedList('mock'), [{ id: '2081371760', role: 'authorized' }])
  assert.deepEqual(store.authorizedList('qqbot'), [])
  assert.equal(await store.removeAuthorized('2081371760', 'mock'), true)
  assert.equal(store.roleOf('2081371760', 'mock'), 'everyone')
})

test('旧数据迁移：无前缀的 homeChannel/roles 归到 qqbot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-store-mig-'))
  // 模拟旧版 store：全局 homeChannel=QQ号，roles 也是裸 id。本仓库只有官方线，统一归 qqbot。
  await writeFile(
    join(dir, 'store.v1.json'),
    JSON.stringify({
      version: 1,
      chats: {},
      pairing: { policy: 'pairing', roles: { '2081371760': 'authorized', A6AB252127520117332879C06EE346AC: 'authorized' }, pending: [] },
      meta: { homeChannel: '3298364424', accountId: '', updatedAt: 0 },
    }),
    'utf8',
  )
  const store = createStore({ dir })
  await store.load()

  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.meta.homeChannels, { qqbot: '3298364424' })
  assert.equal(snapshot.pairing.roles['qqbot:2081371760'], 'authorized', '旧的无前缀记录归 qqbot')
  assert.equal(snapshot.pairing.roles['qqbot:A6AB252127520117332879C06EE346AC'], 'authorized')
  assert.equal(snapshot.pairing.roles['2081371760'], undefined, '旧的无前缀记录要迁走')
  assert.equal(store.roleOf('3298364424', 'qqbot'), 'owner')
  assert.equal(store.roleOf('A6AB252127520117332879C06EE346AC', 'qqbot'), 'authorized')
})

test('活动计数：按天按线路累加、近 7 天补零、重启后不丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-activity-'))
  const store = createStore({ dir })
  await store.load()

  await store.recordActivity('qqbot')
  await store.recordActivity('qqbot')
  await store.recordActivity('qqbot')
  await store.recordActivity('')  // 空 kind 忽略

  const series = store.activity(7)
  assert.equal(series.length, 7)
  const today = series.at(-1)
  assert.equal(typeof today.date, 'string')
  assert.equal(today.qqbot, 3)
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

  await store.recordUsage('qqbot:1905346673:dm:user-a', { inputTokens: 100, outputTokens: 40, totalTokens: 140 })
  await store.recordUsage('qqbot:1905346673:dm:user-a', { inputTokens: 10, outputTokens: 5 })
  await store.recordUsage('mock:10001:group:90001', { promptTokens: 200, completionTokens: 50 })
  assert.equal(await store.recordUsage('', { totalTokens: 1 }), null, '空 chatKey 忽略')
  assert.equal(await store.recordUsage('qqbot:x', {}), null, '没有用量的 usage 忽略')

  const report = store.usageReport({ days: 30 })
  assert.equal(report.span, 30)
  assert.equal(report.days.length, 30, '固定 30 天序列')
  assert.deepEqual(report.totals.today, { total: 405, input: 310, output: 95, turns: 3 })
  assert.equal(report.totals.week.total, 405, '只用今天的数据时 7 天 = 今天')
  assert.equal(report.totals.month.total, 405)
  assert.deepEqual(report.chats.map(row => row.chatKey).slice(0, 2), [
    'mock:10001:group:90001',
    'qqbot:1905346673:dm:user-a',
  ], '按总消耗降序')
  assert.equal(report.chats[1].turns, 2)
  assert.equal(report.chats[0].days[report.days.at(-1).date].total, 250)

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
    await store.recordUsage('qqbot:1905346673:dm:user-a', { totalTokens: 1 })
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
  assert.equal(store.promptFor('qqbot:1:group:2'), '')
  assert.deepEqual(store.promptChats(), {})

  await store.setDefaultPrompt('你是群助手，回答简短。')
  assert.equal(store.promptFor('qqbot:1:group:2'), '你是群助手，回答简短。')
  await store.setChatPrompt('qqbot:1:group:2', '这个群只聊技术。')
  assert.equal(store.promptFor('qqbot:1:group:2'), '这个群只聊技术。', '对话覆盖优先于默认')
  assert.equal(store.promptFor('qqbot:1:dm:9'), '你是群助手，回答简短。', '其它对话回落到默认')
  assert.deepEqual(store.promptChats(), { 'qqbot:1:group:2': '这个群只聊技术。' })

  // 空文本 = 清除覆盖
  await store.setChatPrompt('qqbot:1:group:2', '')
  assert.equal(store.promptFor('qqbot:1:group:2'), '你是群助手，回答简短。')
  assert.deepEqual(store.promptChats(), {})

  await assert.rejects(() => store.setDefaultPrompt('x'.repeat(4001)), /太长/)
  await assert.rejects(() => store.setChatPrompt('qqbot:1:group:2', 'x'.repeat(4001)), /太长/)
  await assert.rejects(() => store.setChatPrompt('', 'x'), /不能为空/)

  await store.setChatPrompt('qqbot:1:group:2', '持久化')
  const reloaded = createStore({ dir })
  await reloaded.load()
  assert.equal(reloaded.defaultPrompt(), '你是群助手，回答简短。')
  assert.equal(reloaded.promptFor('qqbot:1:group:2'), '持久化')
})
