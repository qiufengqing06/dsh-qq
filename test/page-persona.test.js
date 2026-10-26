import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const html = await readFile(new URL('../lib/page.html', import.meta.url), 'utf8')

// Execute the page's real functions; this DOM double only models fields and events.
function source(name) {
  const start = html.indexOf(`\n  function ${name}(`)
  const end = html.indexOf('\n  }', start)
  assert.ok(start >= 0 && end > start, `missing page function: ${name}`)
  return html.slice(start, end + 4)
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.events = new Map()
    this.value = ''
    this.disabled = false
    this.ownText = ''
  }
  set textContent(value) { this.ownText = String(value); this.children = [] }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  setAttribute(name, value) { this[name] = String(value) }
  appendChild(child) { this.children.push(child); return child }
  addEventListener(type, listener) {
    const listeners = this.events.get(type) ?? []
    listeners.push(listener)
    this.events.set(type, listeners)
  }
  emit(type) { for (const listener of this.events.get(type) ?? []) listener({ target: this }) }
}

function find(root, matches) {
  if (matches(root)) return root
  for (const child of root.children) {
    const result = find(child, matches)
    if (result) return result
  }
  return null
}

const settle = () => new Promise(resolve => setImmediate(resolve))

function page() {
  const roots = new Map(['prompts', 'fresh', 'fresh-text', 'badge-prompts', 'prompts-note'].map(id => {
    const node = new Element('div')
    node.id = id
    return [id, node]
  }))
  const document = {
    activeElement: null,
    createElement: tag => new Element(tag),
    createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
    getElementById: id => {
      for (const root of roots.values()) {
        const found = find(root, node => node.id === id)
        if (found) return found
      }
      return null
    },
  }
  const state = {
    personas: [{ id: '002', name: '测试角色', chars: 4 }],
    prompt: { default: '', chats: {} }, modes: {}, chatKeys: [], promptLimit: 4000,
    lines: [], status: {},
  }
  const posts = []
  const notices = []
  let failure = ''
  let pendingState = null
  const context = {
    document, window: { confirm: () => true },
    S: structuredClone(state), dirty: {}, personaEditing: '', personaDraft: null, promptEditing: '',
    HDR: { 'content-type': 'application/json', 'x-dsh-qq-panel': '1' },
    notice: message => notices.push(message), fmtTime: () => 'test-time',
    fetch: async (path, options) => {
      let data
      if (path === '/dsh-qq/api/state') {
        if (pendingState) await pendingState.promise
        data = { ok: true, state: structuredClone(state) }
      } else if (path === '/dsh-qq/api/personas?id=002') {
        // Existing hosts return the stored body without its map key (id).
        data = { ok: true, persona: { name: '测试角色', text: '旧人设内容', updatedAt: 1 } }
      } else {
        assert.equal(path, '/dsh-qq/api/personas')
        assert.equal(options.method, 'POST')
        posts.push(JSON.parse(options.body))
        data = failure ? { ok: false, error: failure } : { ok: true }
      }
      return { status: 200, json: async () => data }
    },
  }
  for (const [, name] of source('render').matchAll(/\b(render[A-Z]\w*)\(\)/g)) {
    if (name !== 'renderPrompts') context[name] = () => {}
  }
  const functions = ['el', 'btn', 'pill', 'api', 'personaById', 'personaOrder', 'personaAction',
    'startPersonaEdit', 'personaEditor', 'renderPersonaBlock', 'renderPrompts', 'render', 'load']
  vm.createContext(context)
  vm.runInContext(functions.map(source).join('\n'), context)
  return {
    posts, notices, context, document,
    field: id => document.getElementById(`persona-${id}`),
    async open(id = '002') { context.startPersonaEdit(id); await settle() },
    input(id, value) {
      const node = document.getElementById(`persona-${id}`)
      assert.ok(node, `missing persona-${id}`)
      node.value = value
      document.activeElement = node
      node.emit('input')
      return node
    },
    async click(label) {
      const button = find(roots.get('prompts'), node => node.tagName === 'BUTTON' && node.textContent === label)
      assert.ok(button, `missing button: ${label}`)
      document.activeElement = button
      button.emit('click')
      await settle()
    },
    fail(message) { failure = message },
    delayRefresh() {
      let release
      pendingState = { promise: new Promise(resolve => { release = resolve }) }
      const done = context.load()
      return async () => { release(); await done; pendingState = null }
    },
  }
}

test('既有人设：旧后端不返回 id，仍显示并保存稳定的 002', async () => {
  const app = page()
  await app.open()
  assert.equal(app.field('id').value, '002')
  assert.equal(app.field('id').disabled, true)
  app.input('name', ' 修改后的名称 ')
  app.input('text', '修改后的人设内容')
  app.field('id').value = '' // The disabled field must not become the identity source.
  await app.click('保存')
  assert.deepEqual(app.posts, [{ action: 'save', id: '002', name: '修改后的名称', text: '修改后的人设内容' }])
  assert.equal(app.field('text'), null)
})

test('既有人设：删除使用稳定的 002，不依赖详情响应中的 id', async () => {
  const app = page()
  await app.open()
  await app.click('删除')
  assert.deepEqual(app.posts, [{ action: 'delete', id: '002' }])
  assert.equal(app.field('text'), null)
})

test('失焦及已在途的状态刷新保留草稿、编辑器节点与选区', async () => {
  const app = page()
  const finishRefresh = app.delayRefresh()
  await app.open()
  app.input('name', '尚未保存的名字')
  const textarea = app.input('text', '尚未保存的正文')
  textarea.selectionStart = 2
  textarea.selectionEnd = 4
  app.document.activeElement = null
  await finishRefresh()
  await app.context.load()
  assert.equal(app.field('text'), textarea)
  assert.equal(textarea.value, '尚未保存的正文')
  assert.equal(textarea.selectionStart, 2)
  assert.equal(textarea.selectionEnd, 4)
  assert.equal(app.field('name').value, '尚未保存的名字')
  // Explicit prompt-panel redraws also use the synchronized draft.
  app.context.renderPrompts()
  assert.equal(app.field('text').value, '尚未保存的正文')
  assert.equal(app.field('name').value, '尚未保存的名字')
})

test('新建人设的 id、名称和正文均同步草稿并按用户输入保存', async () => {
  const app = page()
  await app.open('')
  assert.equal(app.field('id').disabled, false)
  app.input('id', ' new_persona ')
  app.input('name', ' 新人设 ')
  app.input('text', '新正文\n第二行')
  app.document.activeElement = null
  await app.context.load()
  app.context.renderPrompts()
  assert.equal(app.field('id').value, ' new_persona ')
  assert.equal(app.field('name').value, ' 新人设 ')
  assert.equal(app.field('text').value, '新正文\n第二行')
  await app.click('保存')
  assert.deepEqual(app.posts, [{ action: 'save', id: 'new_persona', name: '新人设', text: '新正文\n第二行' }])
})

test('保存或删除失败保留未保存内容，刷新后仍可重试保存', async () => {
  const app = page()
  await app.open()
  app.input('name', '失败时保留名称')
  const textarea = app.input('text', '失败时保留正文')
  app.fail('模拟存储失败')
  await app.click('保存')
  await app.click('删除')
  app.document.activeElement = null
  await app.context.load()
  assert.equal(app.field('text'), textarea)
  assert.equal(app.field('name').value, '失败时保留名称')
  assert.equal(app.field('text').value, '失败时保留正文')
  assert.ok(app.notices.includes('模拟存储失败'))
  app.fail('')
  await app.click('保存')
  assert.deepEqual(app.posts.at(-1), { action: 'save', id: '002', name: '失败时保留名称', text: '失败时保留正文' })
  assert.equal(app.field('text'), null)
})
