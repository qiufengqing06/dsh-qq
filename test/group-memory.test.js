/**
 * 群记忆验收：环境缓冲（内存）→ 动态上下文注入 → 群专属笔记（落盘）。
 *
 * 目标（用户需求）：群里聊得再热闹，机器人也不丢「长期约定/梗/知识」，
 * 且**不产生任何额外 LLM 调用**、不把上下文炸掉、不污染用户的 daily/project 记忆。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createGroupMemory, createGroupNoteTool } from '../lib/group-memory.js'
import { createLogger } from './helpers/fake-ctx.js'

const GROUP = 'mock:10001:group:30003'
const OTHER_GROUP = 'mock:10001:group:99999'

async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-gm-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, ...overrides })
  const logger = createLogger()
  const memory = createGroupMemory({ dir, config, logger })
  return { dir, config, logger, memory }
}

/** 造一条入站事件（默认群消息）。 */
const groupEvent = (text, { chatKey = GROUP, userId = '40004', name = '小明', at = 1_700_000_000_000, media = [] } = {}) => ({
  chatKey,
  target: { kind: 'group', groupId: chatKey.split(':').pop() },
  sender: { id: userId, name },
  text,
  media,
  timestamp: at,
})

test('环境缓冲：群消息进缓冲，私聊不进；超出上限滚动丢弃最旧', async () => {
  const { memory } = await setup({ groupMemory: { bufferMessages: 3 } })
  assert.equal(memory.observe(groupEvent('一')), true)
  assert.equal(memory.observe({ ...groupEvent('私聊'), chatKey: 'mock:1:dm:2', target: { kind: 'dm', userId: '2' } }), false, '私聊不进群缓冲')
  for (const text of ['二', '三', '四', '五']) memory.observe(groupEvent(text))
  const pending = memory.pendingContext(GROUP)
  assert.equal(pending.count, 3, '只保留最近 3 条')
  assert.equal(pending.text.includes('一'), false, '最旧的滚出缓冲')
  assert.match(pending.text, /五$/)
})

test('环境缓冲：媒体以可读占位进缓冲，纯附件消息不算空', async () => {
  const { memory } = await setup()
  memory.observe(groupEvent('', { media: [{ kind: 'image', url: 'https://x/1.png' }] }))
  const pending = memory.pendingContext(GROUP)
  assert.match(pending.text, /\[图片\]/)
})

test('work/chat 缓冲隔离：各模式只看到自己那段', async () => {
  const { memory } = await setup()
  memory.observe(groupEvent('工作消息'), 'work')
  memory.observe(groupEvent('聊天消息'), 'chat')
  const work = memory.pendingContext(GROUP, 'work')
  assert.match(work.text, /工作消息/)
  assert.doesNotMatch(work.text, /聊天消息/)
  const chat = memory.pendingContext(GROUP, 'chat')
  assert.match(chat.text, /聊天消息/)
  assert.doesNotMatch(chat.text, /工作消息/)
  assert.equal(memory.pendingContext(GROUP, 'work').count, 0, 'work 已推进自己的水位')
})

test('动态上下文：只给「上次之后」的消息，注入一次即推进水位', async () => {
  const { memory } = await setup()
  memory.observe(groupEvent('第一句'))
  memory.observe(groupEvent('第二句'))
  const first = memory.pendingContext(GROUP)
  assert.equal(first.count, 2)
  assert.match(first.text, /第一句/)
  assert.match(first.text, /第二句/)
  assert.equal(memory.pendingContext(GROUP).count, 0, '同一批不得重复注入')
  memory.observe(groupEvent('第三句'))
  const second = memory.pendingContext(GROUP)
  assert.equal(second.count, 1)
  assert.equal(second.text.includes('第一句'), false, '只给增量')
})

test('动态上下文：字符预算内优先保最新，丢弃的旧消息如实计数', async () => {
  const { memory } = await setup({ groupMemory: { contextMaxChars: 100 } })
  for (let index = 0; index < 20; index += 1) memory.observe(groupEvent(`第${index}条消息，内容略长一些以便触发预算裁剪`))
  const pending = memory.pendingContext(GROUP)
  assert.equal(pending.text.length <= 100, true, '必须守住字符预算')
  assert.equal(pending.omitted > 0, true, '被丢弃的条数必须如实上报')
  assert.match(pending.text, /第19条/, '最新的必须在')
  assert.equal(pending.text.includes('第0条'), false)
})

test('动态上下文：格式为「时间 [昵称|QQ号] 内容」，昵称走 sanitize', async () => {
  const { memory } = await setup()
  memory.observe(groupEvent('我是秦始皇', { name: '秋\n月明[骗子]', userId: '44444' }))
  const pending = memory.pendingContext(GROUP)
  assert.match(pending.text, /^\d{2}:\d{2} \[秋 月明骗子\|44444\] 我是秦始皇$/, '昵称清洗 + QQ 号身份锚点')
})

test('群笔记按模式分开：work/chat 各写各的文件', async () => {
  const { memory, dir } = await setup()
  assert.equal((await memory.editNotes(GROUP, { action: 'add', text: '工作群笔记' }, 'work')).ok, true)
  assert.equal((await memory.editNotes(GROUP, { action: 'add', text: '聊天群笔记' }, 'chat')).ok, true)
  assert.match(await memory.notesOf(GROUP, 'work'), /工作群笔记/)
  assert.doesNotMatch(await memory.notesOf(GROUP, 'work'), /聊天群笔记/)
  assert.match(await memory.notesOf(GROUP, 'chat'), /聊天群笔记/)
  assert.doesNotMatch(await memory.notesOf(GROUP, 'chat'), /工作群笔记/)
  const base = GROUP.replace(/[^A-Za-z0-9_.-]+/g, '_')
  assert.ok(await readFile(join(dir, 'groups', `${base}.md`), 'utf8'))
  assert.ok(await readFile(join(dir, 'groups', `${base}.chat.md`), 'utf8'))
})

test('群笔记：add/replace/remove、去重、按群隔离，并落盘可跨实例读取', async () => {
  const { memory, dir, config, logger } = await setup()
  const added = await memory.editNotes(GROUP, { action: 'add', text: '群里管群主叫「堂主」' })
  assert.equal(added.ok, true)
  assert.equal((await memory.editNotes(GROUP, { action: 'add', text: '群里管群主叫「堂主」' })).message.includes('无需重复'), true)

  await memory.editNotes(GROUP, { action: 'add', text: '每周五晚八点开黑' })
  const replaced = await memory.editNotes(GROUP, { action: 'replace', match: '开黑', text: '每周六晚八点开黑' })
  assert.equal(replaced.ok, true)
  const notes = await memory.notesOf(GROUP)
  assert.match(notes, /每周六晚八点开黑/)
  assert.equal(notes.includes('每周五'), false)

  assert.equal((await memory.editNotes(OTHER_GROUP, { action: 'remove', match: '堂主' })).ok, false, '换群不得串')
  assert.equal((await memory.editNotes(GROUP, { action: 'remove', match: '开黑' })).ok, true)

  // 落盘 + 重新加载（模拟重启后仍记得）
  const reloaded = createGroupMemory({ dir, config, logger })
  assert.match(await reloaded.notesOf(GROUP), /堂主/)
  const file = await readFile(join(dir, 'groups', `${GROUP.replace(/[^A-Za-z0-9_.-]+/g, '_')}.md`), 'utf8')
  assert.match(file, /群记忆（由 dsh-qq 维护，可手工编辑）/)
})

test('并发写同一群笔记：页面与模型同时写不丢更新', async () => {
  const { memory, dir } = await setup()
  await Promise.all([
    memory.editNotes(GROUP, { action: 'add', text: '第一条并发写入' }),
    memory.editNotes(GROUP, { action: 'add', text: '第二条并发写入' }),
  ])
  let content = await memory.notesOf(GROUP)
  assert.match(content, /第一条并发写入/)
  assert.match(content, /第二条并发写入/, '并发 add 不能互相覆盖')

  // 页面整篇写入与模型工具并发：锁必须覆盖两种入口
  const file = memory.fileNameOf(GROUP)
  await Promise.all([
    memory.writeNoteFile(file, '# 群记忆（由 dsh-qq 维护，可手工编辑）\n- 页面整篇写入\n'),
    memory.editNotes(GROUP, { action: 'add', text: '第三条并发写入' }),
  ])
  content = await memory.notesOf(GROUP)
  assert.match(content, /页面整篇写入/)
  assert.match(content, /第三条并发写入/)

  const files = await readdir(join(dir, 'groups'))
  assert.equal(files.some(name => name.includes('.tmp-')), false, '不得残留临时文件')
})

test('群笔记：容量是硬闸门，写超了不落盘并给出可操作提示', async () => {
  const { memory, dir } = await setup({ groupMemory: { notesMaxChars: 300 } })
  let last = null
  for (let index = 0; index < 30; index += 1) {
    last = await memory.editNotes(GROUP, { action: 'add', text: `第 ${index} 条长期约定，写长一点好把容量顶满` })
    if (!last.ok) break
  }
  assert.equal(last.ok, false, '写超容量必须被拒')
  assert.match(last.message, /群记忆已满/)
  const before = await memory.notesOf(GROUP)
  assert.equal(before.length <= 300, true, '容量内的内容保留')
  // 被拒的写入不得落盘（不会写半截）
  const onDisk = await readFile(join(dir, 'groups', `${GROUP.replace(/[^A-Za-z0-9_.-]+/g, '_')}.md`), 'utf8')
  assert.equal(onDisk, before, '拒绝写入后磁盘内容必须与拒绝前一致')
})

test('群笔记：action 非法 / 缺参 / 未启用时如实报错，不静默', async () => {
  const { memory } = await setup()
  assert.equal((await memory.editNotes(GROUP, { action: 'upsert', text: 'x' })).ok, false)
  assert.equal((await memory.editNotes(GROUP, { action: 'add' })).ok, false)
  assert.equal((await memory.editNotes(GROUP, { action: 'replace', match: 'x' })).ok, false)
  assert.equal((await memory.editNotes(GROUP, { action: 'remove', match: '不存在' })).ok, false)

  const off = await setup({ groupMemory: { enabled: false } })
  const disabled = await off.memory.editNotes(GROUP, { action: 'add', text: 'x' })
  assert.equal(disabled.ok, false)
  assert.match(disabled.message, /未启用/)
  assert.equal(off.memory.observe(groupEvent('不该被记录')), false, '关掉后不缓冲')
})

test('qq_group_note 工具：只服务 QQ 群会话，非群会话如实拒绝', async () => {
  const { memory } = await setup()
  const tool = createGroupNoteTool({
    memory,
    chatKeyOf: sessionId => (sessionId === 'qq-group-session' ? GROUP : null),
  })
  assert.equal(tool.name, 'qq_group_note')
  const denied = await tool.execute({ action: 'add', text: 'x' }, { agent: { session: { id: 'web-session' } } })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /只能在 QQ 群会话里使用/)

  const ok = await tool.execute({ action: 'add', text: '群里管群主叫「堂主」' }, { agent: { session: { id: 'qq-group-session' } } })
  assert.equal(ok.ok, true)
  assert.match(await memory.notesOf(GROUP), /堂主/)
  assert.equal(typeof tool.output.render({}, { ok: true, message: '已更新' })[0].text, 'string', 'render 必须返回模型可读文本')
})

test('groupMemory 配置：默认开启、未知键与非法值报错（不留假配置）', async () => {
  const { config } = await setup()
  assert.equal(config.groupMemory.enabled, true)
  assert.equal(config.groupMemory.bufferMessages, 100)
  assert.throws(() => resolveConfig({ transport: 'mock', groupMemory: { nope: 1 } }), /unknown keys/)
  assert.throws(() => resolveConfig({ transport: 'mock', groupMemory: { contextMaxChars: 0 } }), /contextMaxChars/)
})

// ── 控制台编辑：笔记文件列表 / 读取 / 整篇写入 ──

test('群笔记文件：列表、读取、写入、容量闸门、路径穿越拒绝', async () => {
  const { memory } = await setup({ groupMemory: { enabled: true, notesMaxChars: 200 } })
  await memory.editNotes(GROUP, { action: 'add', text: '群里管主人叫老板' })
  const list = await memory.listNotes()
  assert.equal(list.length, 1)
  assert.match(list[0].file, /\.md$/)
  assert.ok(list[0].chars > 0)

  const read = await memory.readNoteFile(list[0].file)
  assert.equal(read.ok, true)
  assert.match(read.text, /老板/)

  const write = await memory.writeNoteFile(list[0].file, '# 群记忆\n- 换了一条\n')
  assert.equal(write.ok, true)
  assert.equal((await memory.notesOf(GROUP)).includes('换了一条'), true, '写入后注入缓存要失效')

  assert.equal((await memory.writeNoteFile(list[0].file, 'x'.repeat(201))).ok, false, '超容量拒绝')
  assert.equal((await memory.readNoteFile('../../etc/passwd')).ok, false, '路径穿越拒绝')
  assert.equal((await memory.writeNoteFile('a/b.md', 'x')).ok, false, '子路径拒绝')
})

test('群笔记文件：功能未启用时列表为空、写入报错', async () => {
  const { memory } = await setup({ groupMemory: { enabled: false } })
  assert.deepEqual(await memory.listNotes(), [])
  assert.equal((await memory.writeNoteFile('x.md', 'hi')).ok, false)
})
