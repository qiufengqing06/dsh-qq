import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const html = await readFile(new URL('../lib/page.html', import.meta.url), 'utf8')
function source(name) {
  const start = html.indexOf('\n  function ' + name + '(')
  const end = html.indexOf('\n  }', start)
  assert.ok(start >= 0 && end > start, 'missing function ' + name)
  return html.slice(start, end + 4)
}
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.style = {}; this.value = ''; this.ownText = ''; this.disabled = false }
  set textContent(text) { this.ownText = String(text); this.children = [] }
  get textContent() { return this.ownText + this.children.map(x => x.textContent).join('') }
  setAttribute(k, v) { this[k] = String(v) }
  appendChild(n) { this.children.push(n); return n }
  insertBefore(n, before) { const i = this.children.indexOf(before); this.children.splice(i < 0 ? 0 : i, 0, n); return n }
  get firstChild() { return this.children[0] }
  addEventListener(event, fn) { (this.events[event] ||= []).push(fn) }
  emit(event) { for (const fn of this.events[event] || []) fn({ target: this, preventDefault() {} }) }
  contains(node) { return this === node || this.children.some(x => x.contains(node)) }
  querySelectorAll(selector) {
    const tags = new Set(selector.split(',').map(x => x.trim().toUpperCase()))
    return this.children.flatMap(x => [...(tags.has(x.tagName) ? [x] : []), ...x.querySelectorAll(selector)])
  }
  focus() {}
  click() { this.emit('click') }
}
function find(n, predicate) { if (predicate(n)) return n; for (const c of n.children) { const result = find(c, predicate); if (result) return result } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const A = 'qqbot:fixture:group:10001'
const B = 'qqbot:fixture:group:10002'
const row = (id = 'f1') => ({ id, text: '小林不吃香菜', kind: 'preference', subject: { kind: 'member', id: '11001' }, key: '饮食偏好', sourceKind: 'explicit', status: 'confirmed', revision: 2, updatedAt: 1, evidence: [{ senderId: '11001', receivedAt: 1, excerpt: '我不吃香菜' }] })
function fixture(extra = {}) {
  return { ok: true, revision: 3, items: [row()], total: 1, page: 1, limit: 20, personaIdentity: '002',
    learning: { enabled: true, paused: false }, emotion: { enabled: true }, habits: [{ id: 'h1', dimension: 'length', value: '简短自然', subjectId: '', locked: false, evidence: [] }],
    mood: { label: 'happy', intensity: 0.5, targetMemberId: '11001', reason: '刚被夸奖', createdAt: Date.now(), expiresAt: Date.now() + 60000 }, candidates: [], tombstones: [], ...extra }
}
function app(options = {}) {
  const roots = new Map(['conversation-memory', 'groups', 'badge-groups', 'groups-note'].map(id => { const n = new Node('div'); n.id = id; return [id, n] }))
  const doc = {
    activeElement: null, createElement: tag => new Node(tag), createTextNode: text => Object.assign(new Node('text'), { textContent: text }),
    getElementById(id) { for (const root of roots.values()) { const node = find(root, n => n.id === id); if (node) return node } return null },
  }
  const requests = [], notices = [], confirms = [], downloads = [], revoked = []
  const data = new Map([[A, fixture()], [B, fixture({ items: [row('b1')], personaIdentity: '003' })]])
  let fail = '', conflict = false, gate = null, legacyGate = null, legacyReads = 0
  const ctx = {
    document: doc, S: { chatKeys: [A, B], prompt: { chats: {} }, preferences: { chats: {} }, groups: [{ file: 'test_group_10001.md', chars: 5, updatedAt: 1 }], ...(options.state || {}) },
    window: { confirm: message => { confirms.push(message); return true } }, fmtTime: () => '今天', notice: message => notices.push(message),
    memorySelection: { chatKey: '', mode: 'chat' }, memoryViews: {}, editingGroupFile: '', groupDrafts: {}, load: async () => {},
    Blob, URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:fixture' }, revokeObjectURL: url => revoked.push(url) }, setTimeout: fn => fn(),
    api: async (path, body) => {
      requests.push({ path, body: body && JSON.parse(JSON.stringify(body)) })
      if (path.startsWith('/dsh-qq/api/groups/note')) {
        if (!body) { legacyReads++; if (legacyGate) await legacyGate.promise; return { status: 200, data: { ok: true, text: '原始旧笔记', revision: 2 } } }
        return { status: fail ? 400 : 200, data: fail ? { ok: false, error: fail } : { ok: true } }
      }
      if (!body) {
        const key = new URL(path, 'http://fixture').searchParams.get('chatKey')
        const snapshot = structuredClone(data.get(key))
        if (gate?.key === key) await gate.promise
        return { status: 200, data: snapshot }
      }
      if (fail) return { status: conflict ? 409 : 400, data: { ok: false, error: fail, code: conflict ? 'CONFLICT' : 'ERROR' } }
      if (body.action === 'export') return { status: 200, data: { ok: true, text: '# 当前事实\n\n仅含有效内容', file: 'fixture.chat.md', revision: data.get(body.chatKey).revision } }
      const state = data.get(body.chatKey)
      state.revision++
      if (body.action === 'forget') { const item = state.items.find(x => x.id === body.id); state.items = state.items.filter(x => x.id !== body.id); state.total = state.items.length; state.tombstones.push({ id: 't1', subject: item.subject, key: item.key, forgottenAt: Date.now() }) }
      if (body.action === 'correct') state.items.find(x => x.id === body.id).text = body.text
      if (body.action === 'relearn') { state.items.push({ ...row('f2'), text: body.text }); state.tombstones = [] }
      return { status: 200, data: structuredClone(state) }
    },
  }
  const names = ['el', 'btn', 'promptLabel', 'groupLabel', 'renderGroups', 'openGroupEditor', 'saveGroupNote',
    'memoryEntry', 'memoryCurrent', 'memoryField', 'memoryKind', 'memorySubject', 'memoryScopeText', 'renderConversationMemory',
    'fetchMemory', 'renderMemoryStatus', 'exportMemory', 'memoryBusy', 'memoryPost', 'startMemoryEdit', 'memoryEditor', 'memoryEvidence', 'renderMemoryBody', 'renderMemoryGrowth']
  vm.createContext(ctx); vm.runInContext(names.map(source).join('\n'), ctx)
  const field = id => doc.getElementById(id)
  const button = (text, scope = roots.get('conversation-memory')) => {
    const n = find(scope, x => x.tagName === 'BUTTON' && x.textContent === text)
    assert.ok(n, 'missing button ' + text); return n
  }
  return { ctx, data, requests, notices, confirms, downloads, revoked, roots, field, button,
    async open() { ctx.renderConversationMemory(); await tick() },
    async click(text, scope) { button(text, scope).emit('click'); await tick() },
    input(id, text) { const n = field(id); assert.ok(n, id); n.value = text; doc.activeElement = n; n.emit('input'); return n },
    async choose(id, value) { const n = field(id); n.value = value; n.emit('change'); await tick() },
    async poll() { doc.activeElement = null; ctx.renderConversationMemory(); ctx.renderGroups(); await tick() },
    fail(message, isConflict = false) { fail = message; conflict = isConflict },
    delay(key) { let release; gate = { key, promise: new Promise(r => { release = r }) }; return async () => { release(); await tick(); gate = null } },
    delayLegacy() { let release; legacyGate = { promise: new Promise(r => { release = r }) }; return async () => { release(); await tick(); legacyGate = null } },
    get legacyReads() { return legacyReads },
  }
}

test('记忆管理：完整对话/模式及服务端分页过滤，不在单页上伪造筛选', async () => {
  const a = app(); await a.open()
  assert.match(a.requests[0].path, /chatKey=qqbot%3Afixture%3Agroup%3A10001&mode=chat&page=1&limit=20/)
  a.input('memory-query', '香菜'); a.input('memory-member', '11001')
  const form = find(a.roots.get('conversation-memory'), n => n.tagName === 'FORM')
  form.emit('submit'); await tick()
  assert.match(a.requests.at(-1).path, /query=%E9%A6%99%E8%8F%9C&memberId=11001/)
  await a.choose('memory-kind', 'preference')
  assert.match(a.requests.at(-1).path, /kind=preference/)
  await a.choose('memory-mode', 'work')
  assert.equal(a.ctx.memoryEntry().mode, 'work')
  assert.equal(a.field('memory-learningEnabled'), null)
  assert.equal(a.field('memory-emotionEnabled'), null)
})

test('记忆草稿：失焦轮询和保存失败不替换输入节点、选区或提交版本', async () => {
  const a = app(); await a.open(); await a.click('纠正')
  const input = a.input('memory-edit-text', '人工更正后未保存的内容')
  input.selectionStart = 3; input.selectionEnd = 6
  a.data.get(A).revision = 8; await a.poll()
  assert.equal(a.field('memory-edit-text'), input)
  assert.equal(input.value, '人工更正后未保存的内容')
  a.fail('磁盘写入失败')
  await a.click('保存记忆')
  assert.equal(a.field('memory-edit-text'), input)
  assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 6)
  assert.equal(a.requests.at(-1).body.expectedRevision, 3)
  assert.equal(input.disabled, false)
})

test('记忆冲突：先核对服务器新值，再明确确认，不能静默抬高提交版本', async () => {
  const a = app(); await a.open(); await a.click('纠正')
  const input = a.input('memory-edit-text', '我的草稿')
  a.data.get(A).revision = 9; a.data.get(A).items[0].text = '别人刚保存的新内容'
  a.fail('内容已更新，请重新核对', true); await a.click('保存记忆')
  assert.equal(a.ctx.memoryEntry().draft.expectedRevision, 3)
  await a.click('核对最新内容')
  assert.match(a.field('memory-conflict').textContent, /别人刚保存的新内容/)
  assert.equal(a.field('memory-edit-text'), input)
  await a.click('已核对，保留草稿继续编辑')
  assert.equal(a.ctx.memoryEntry().draft.expectedRevision, 9)
  assert.equal(input.value, '我的草稿')
  a.fail(''); await a.click('保存记忆')
  assert.equal(a.requests.filter(x => x.body).at(-1).body.expectedRevision, 9)
})

test('切换对话：旧请求迟到不覆盖新对话，切回可继续原草稿', async () => {
  const a = app(); await a.open(); await a.click('纠正')
  a.input('memory-edit-text', '群 A 的草稿')
  const release = a.delay(A)
  const pending = a.ctx.fetchMemory(a.ctx.memoryEntry(), true)
  await a.choose('memory-chat', B)
  assert.equal(a.ctx.memoryEntry().chatKey, B)
  await release(); await pending
  assert.equal(a.field('memory-chat').value, B)
  assert.equal(a.field('memory-edit-text'), null)
  await a.choose('memory-chat', A)
  assert.equal(a.field('memory-edit-text').value, '群 A 的草稿')
})

test('人设绑定冲突：旧草稿不可通过核对按钮迁移给新角色', async () => {
  const a = app(); await a.open(); await a.click('编辑习惯')
  const input = a.input('habit-value', '只属于原角色的习惯草稿')
  a.data.get(A).personaIdentity = '003'; a.data.get(A).revision = 8
  a.fail('人设已变化，请刷新后再操作', true); await a.click('保存习惯')
  await a.click('核对最新内容')
  assert.match(a.field('memory-conflict').textContent, /绑定人设已变化/)
  assert.equal(a.ctx.memoryEntry().habitDraft.personaIdentity, '002')
  assert.equal(a.ctx.memoryEntry().habitDraft.expectedRevision, 3)
  assert.equal(a.field('habit-value'), input)
  assert.equal(find(a.field('memory-conflict'), n => n.tagName === 'BUTTON'), undefined)
})

test('纠正旧笔记：默认转为事实，既有对象与角色范围不可误改', async () => {
  const a = app(); a.data.get(A).items[0].kind = 'legacy'
  await a.open(); await a.click('纠正')
  assert.equal(a.field('memory-edit-kind').value, 'fact')
  assert.equal(a.field('memory-edit-kind').disabled, true)
  assert.equal(a.field('memory-edit-subject').disabled, true)
  assert.equal(a.field('memory-edit-scoped').disabled, true)
  a.input('memory-edit-text', '核对后的客观事实')
  await a.click('保存记忆')
  const body = a.requests.filter(x => x.body).at(-1).body
  assert.equal(body.kind, 'fact'); assert.equal(body.subjectId, '11001')
})

test('新增及重新记住：明确对象，忘记后不再回显或缓存旧正文', async () => {
  const a = app(); await a.open(); await a.click('新增记忆')
  a.input('memory-edit-text', '小林周五有比赛'); a.input('memory-edit-subject', '11001'); a.input('memory-edit-key', '近期安排')
  await a.click('保存记忆')
  const created = a.requests.find(x => x.body?.action === 'create').body
  assert.equal(created.subjectId, '11001'); assert.equal(created.key, '近期安排')
  assert.equal(created.expectedRevision, 3)
  await a.click('忘记')
  assert.match(a.confirms.at(-1), /停止当前回复并取消本对话未完成消息/)
  assert.doesNotMatch(a.roots.get('conversation-memory').textContent, /小林不吃香菜/)
  await a.click('重新记住')
  assert.equal(a.field('memory-edit-text').value, '')
  a.input('memory-edit-text', '小林现在愿意尝试少量香菜'); await a.click('保存记忆')
  assert.equal(a.requests.find(x => x.body?.action === 'relearn').body.tombstoneId, 't1')
})

test('长期学习和情绪开关独立；锁定、恢复平静、重置习惯使用明确动作', async () => {
  const a = app(); await a.open()
  await a.click('暂停长期学习')
  assert.deepEqual(a.requests.find(x => x.body?.action === 'settings').body, {
    chatKey: A, mode: 'chat', personaIdentity: '002', expectedRevision: 3, action: 'settings', learningPaused: true,
  })
  const moodToggle = a.field('memory-emotionEnabled'); moodToggle.checked = false; moodToggle.emit('change'); await tick()
  const emotion = a.requests.filter(x => x.body?.action === 'settings').at(-1).body
  assert.equal(emotion.emotionEnabled, false); assert.equal(Object.hasOwn(emotion, 'learningPaused'), false)
  await a.click('锁定'); await a.click('恢复平静'); await a.click('重置当前人设的习惯')
  assert.deepEqual(a.requests.filter(x => x.body).slice(-3).map(x => x.body.action), ['lock', 'resetMood', 'resetHabits'])
  assert.match(a.confirms.at(-1), /不会删除长期事实、人设卡或当前情绪/)
})

test('习惯编辑：保持角色和初始版本，轮询后仍提交明确维度与成员', async () => {
  const a = app(); await a.open(); await a.click('编辑习惯')
  const input = a.input('habit-value', '先回答问题，再轻松接话')
  a.input('habit-subject', '11001'); await a.poll()
  assert.equal(a.field('habit-value'), input)
  await a.click('保存习惯')
  const body = a.requests.find(x => x.body?.action === 'editHabit').body
  assert.equal(body.id, 'h1'); assert.equal(body.value, '先回答问题，再轻松接话')
  assert.equal(body.subjectId, '11001'); assert.equal(body.personaIdentity, '002'); assert.equal(body.expectedRevision, 3)
})

test('旧笔记：读取在途输入和失焦轮询均保留草稿，失败后可重试', async () => {
  const a = app(); const release = a.delayLegacy()
  a.ctx.openGroupEditor('test_group_10001.md')
  const input = a.input('group-editor-text', '读取完成前就开始编辑的草稿')
  await release()
  assert.equal(input.value, '读取完成前就开始编辑的草稿')
  a.ctx.renderGroups()
  assert.equal(a.field('group-editor-text'), input); assert.equal(a.legacyReads, 1)
  a.fail('旧笔记保存失败')
  await a.click('保存笔记', a.roots.get('groups'))
  assert.equal(a.field('group-editor-text'), input)
  assert.equal(a.requests.at(-1).body.expectedRevision, 2)
})

test('结构化记忆可用时旧聊天笔记只读，工作笔记仍可编辑', async () => {
  const a = app({ state: { memory: { available: true } } })
  a.ctx.openGroupEditor('test_group_10001.chat.md'); await tick()
  assert.equal(a.field('group-editor-text').readOnly, true)
  assert.equal(find(a.roots.get('groups'), n => n.tagName === 'BUTTON' && n.textContent === '保存笔记'), undefined)
  a.ctx.openGroupEditor('test_group_10001.md'); await tick()
  assert.equal(a.field('group-editor-text').readOnly, false)
  assert.ok(a.button('保存笔记', a.roots.get('groups')))
})

test('工作模式兼容视图不显示新记忆及成长写入动作', async () => {
  const a = app(); a.ctx.memorySelection.mode = 'work'
  a.data.set(A, fixture({ legacy: true, readOnly: true })); await a.open()
  assert.match(a.roots.get('conversation-memory').textContent, /工作模式继续使用下方旧群笔记/)
  assert.equal(a.field('memory-learningEnabled'), null)
  assert.equal(find(a.roots.get('conversation-memory'), n => n.tagName === 'BUTTON' && n.textContent === '新增记忆'), undefined)
})

test('聊天迁移降级：展示服务端只读原因与旧正文，空列表不误称工作模式', async () => {
  const a = app()
  const warning = '旧笔记未能转换为新记忆，目前仅只读，自动学习与情绪已暂停。'
  a.data.set(A, fixture({ legacy: true, readOnly: true, migration: { fallback: true, warning },
    items: [{ id: 'legacy-chat', text: '仍可读取的旧聊天约定。' }], learning: { enabled: false }, emotion: { enabled: false } }))
  await a.open()
  const body = a.field('memory-body')
  assert.match(body.textContent, /旧笔记未能转换为新记忆/)
  assert.match(body.textContent, /仍可读取的旧聊天约定/)
  assert.doesNotMatch(body.textContent, /工作模式|工作对话/)
  assert.equal(a.field('memory-learningEnabled'), null)
  assert.equal(a.field('memory-emotionEnabled'), null)
  assert.equal(a.field('memory-export').disabled, true)
  assert.equal(find(body, n => n.tagName === 'BUTTON'), undefined)
  a.data.get(A).items = []; await a.poll()
  assert.match(body.textContent, /这个聊天对话暂无可读取的旧笔记/)
  assert.doesNotMatch(body.textContent, /工作模式|工作对话/)
})

test('兼容导出：完整范围与版本提交，下载服务端原文，失败不截断或覆盖编辑草稿', async () => {
  const a = app(); await a.open(); await a.click('纠正')
  const input = a.input('memory-edit-text', '导出也不覆盖未保存草稿')
  await a.click('导出兼容笔记')
  const body = a.requests.filter(x => x.body).at(-1).body
  assert.deepEqual(body, { action: 'export', chatKey: A, mode: 'chat', personaIdentity: '002', expectedRevision: 3 })
  assert.equal(await a.downloads[0].text(), '# 当前事实\n\n仅含有效内容')
  assert.deepEqual(a.revoked, ['blob:fixture'])
  assert.equal(a.field('memory-edit-text'), input)
  assert.equal(a.data.get(A).revision, 3)
  a.fail('超过兼容笔记容量，请精简后再导出'); await a.click('导出兼容笔记')
  assert.equal(a.downloads.length, 1)
  assert.match(a.field('memory-status').textContent, /超过兼容笔记容量/)
  assert.equal(a.field('memory-edit-text').value, '导出也不覆盖未保存草稿')
  await a.choose('memory-mode', 'work')
  assert.equal(a.field('memory-export').disabled, true)
})
