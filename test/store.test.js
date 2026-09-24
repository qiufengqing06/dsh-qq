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
