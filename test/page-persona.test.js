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
    this.style = {}
  }
  set textContent(value) { this.ownText = String(value); this.children = [] }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  setAttribute(name, value) { this[name] = String(value) }
  appendChild(child) { this.children.push(child); return child }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  addEventListener(type, listener) {
    const listeners = this.events.get(type) ?? []
    listeners.push(listener)
    this.events.set(type, listeners)
  }
  focus() {}
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

function page(options = {}) {
  const roots = new Map(['prompts', 'fresh', 'fresh-text', 'badge-prompts', 'prompts-note', 'stickers', 'chat-control'].map(id => {
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
  if (options.chatKey) { state.chatKeys = [options.chatKey]; state.modes[options.chatKey] = 'work' }
  const posts = []
  const previews = []
  const libraryReads = []
  const notices = []
  const local = new Map()
  let failure = ''
  let pendingState = null
  let previewFailure = ''
  let pendingPreview = null
  const context = {
    document, window: { confirm: () => true },
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
    S: structuredClone(state), dirty: {}, personaEditing: '', personaDraft: null, promptEditing: '',
    personaStickerState: null, personaTrial: null, personaPreviews: {}, diagnosticOpen: {},
    stickerEditors: {}, stickerFocus: '', stickerLoading: false,
    HDR: { 'content-type': 'application/json', 'x-dsh-qq-panel': '1' },
    notice: message => notices.push(message), fmtTime: () => 'test-time',
    fetch: async (path, requestOptions) => {
      let data
      if (path === '/dsh-qq/api/state') {
        if (pendingState) await pendingState.promise
        data = { ok: true, state: structuredClone(state) }
      } else if (path === '/dsh-qq/api/personas?id=002') {
        // Existing hosts return the stored body without its map key (id).
        data = { ok: true, persona: { name: '测试角色', text: '旧人设内容', updatedAt: 1, stickerIds: options.stickerIds ?? [] } }
      } else if (path.startsWith('/dsh-qq/api/persona-stickers?')) {
        libraryReads.push(path)
        data = options.libraryError ? { ok: false, error: options.libraryError } : { ok: true, items: options.items ?? [] }
      } else if (path === '/dsh-qq/api/persona-preview') {
        const body = JSON.parse(requestOptions.body)
        previews.push(body)
        if (pendingPreview) await pendingPreview.promise
        const effective = {
          mode: body.mode, source: body.draft ? 'draft' : 'binding',
          personaName: body.draft?.name ?? '已保存角色', text: body.draft?.text ?? '已保存正文',
          chatNote: '聊天规则内容', stickerIds: body.draft?.stickerIds ?? [], stickers: [],
          notice: '只展示QQ插件提示，不含真实群历史。',
        }
        data = previewFailure ? { ok: false, error: previewFailure } : {
          ok: true, effective, model: { provider: 'fixture', model: 'mock-model' },
          ...((body.message || body.imageStickerId) ? (options.actions ? { reply: '', actions: options.actions, warnings: ['仅图文预演'] } : { reply: '试聊回复：' + body.message }) : {}),
        }
      } else {
        assert.equal(path, '/dsh-qq/api/personas')
        assert.equal(requestOptions.method, 'POST')
        posts.push(JSON.parse(requestOptions.body))
        data = failure ? { ok: false, error: failure } : { ok: true }
      }
      return { status: 200, json: async () => data }
    },
  }
  for (const [, name] of source('render').matchAll(/\b(render[A-Z]\w*)\(/g)) {
    if (name !== 'renderPrompts') context[name] = () => {}
  }
  const functions = ['el', 'btn', 'pill', 'api', 'activityLabel', 'activitySelect', 'personaAliases', 'releasePersonaTrial', 'personaById', 'personaOrder', 'personaAction',
    'startPersonaEdit', 'personaStickerIds', 'personaStickerPicker', 'personaEffectiveDetails', 'renderPersonaPreview',
    'showPersonaPreview', 'personaTrialPanel', 'personaEditor', 'renderPersonaBlock', 'renderPrompts', 'promptLabel', 'render', 'load']
  vm.createContext(context)
  vm.runInContext(functions.map(source).join('\n'), context)
  return {
    posts, previews, libraryReads, notices, context, document, local, roots,
    useFunctions(names) { vm.runInContext(names.map(source).join('\n'), context) },
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
    async clickLabel(label) {
      const button = find(roots.get('prompts'), node => node.tagName === 'BUTTON' && node['aria-label'] === label)
      assert.ok(button, `missing button label: ${label}`)
      document.activeElement = button
      button.emit('click')
      await settle()
    },
    fail(message) { failure = message },
    failPreview(message) { previewFailure = message },
    delayPreview() {
      let release
      pendingPreview = { promise: new Promise(resolve => { release = resolve }) }
      return async () => { release(); await settle(); pendingPreview = null }
    },
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
  assert.deepEqual(app.posts, [{ action: 'save', id: '002', name: '修改后的名称', text: '修改后的人设内容', stickerIds: [], aliases: [], activity: 'inherit' }])
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
  assert.deepEqual(app.posts, [{ action: 'save', id: 'new_persona', name: '新人设', text: '新正文\n第二行', stickerIds: [], aliases: [], activity: 'inherit' }])
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
  assert.deepEqual(app.posts.at(-1), { action: 'save', id: '002', name: '失败时保留名称', text: '失败时保留正文', stickerIds: [], aliases: [], activity: 'inherit' })
  assert.equal(app.field('text'), null)
})

test('精选表情：保留缺失编号，搜索和选图不重建正文，保存时携带选择', async () => {
  const app = page({
    stickerIds: ['missing-image'],
    items: [{ id: 'smile', desc: '开心微笑', tags: ['微笑'], state: 'library' }, { id: 'missing-image', missing: true }],
  })
  await app.open()
  assert.match(app.libraryReads[0], /ids=missing-image/)
  const textarea = app.input('text', '未保存的正文')
  app.input('sticker-search', '微笑')
  await app.clickLabel('选择表情：开心微笑')
  assert.equal(app.field('text'), textarea)
  assert.equal(app.field('text').value, '未保存的正文')
  assert.deepEqual([...app.context.personaDraft.stickerIds], ['missing-image', 'smile'])
  app.input('name', '改名不清空表情')
  await app.clickLabel('移除精选表情：missing-imag（未找到）')
  app.document.activeElement = null
  await app.context.load()
  assert.equal(app.field('text'), textarea)
  assert.equal(app.field('sticker-count').textContent, '已选 1 / 40')
  await app.click('保存')
  assert.deepEqual(app.posts[0].stickerIds, ['smile'])
})

test('精选表情限制 40 张；图库读取失败不会清空原绑定', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => `image-${i}`)
  const app = page({ stickerIds: ids, items: [{ id: 'extra', desc: '第41张', tags: [], state: 'library' }] })
  await app.open()
  await app.clickLabel('选择表情：第41张')
  assert.deepEqual([...app.context.personaDraft.stickerIds], ids)
  const failed = page({ stickerIds: ['kept'], libraryError: '图库暂不可用' })
  await failed.open()
  await failed.click('保存')
  assert.deepEqual(failed.posts[0].stickerIds, ['kept'])
})

test('对话生效预览只传对话和模式，不混入正在编辑的未保存草稿', async () => {
  const chatKey = 'qqbot:account:group:fixture'
  const app = page({ chatKey })
  await app.open()
  const textarea = app.input('text', '不应出现在绑定预览请求中的草稿')
  await app.click('生效预览')
  assert.deepEqual(app.previews, [{ chatKey, mode: 'work' }])
  const panel = app.document.getElementById('persona-effective-' + encodeURIComponent(chatKey))
  assert.match(panel.textContent, /已保存正文/)
  assert.match(panel.textContent, /聊天规则内容/)
  assert.match(panel.textContent, /不含真实群历史/)
  assert.equal(app.field('text'), textarea)
  assert.deepEqual(app.posts, [])
})

test('文字试聊携带未保存草稿供预览，修改人设后不沿用旧试聊历史', async () => {
  const app = page({ stickerIds: ['chosen'] })
  await app.open()
  const textarea = app.input('text', '此刻未保存的人设')
  app.input('name', '未保存名字')
  app.input('trial-message', '第一句')
  await app.click('试聊')
  assert.deepEqual(app.previews[0], {
    mode: 'chat', draft: { id: '002', name: '未保存名字', text: '此刻未保存的人设', stickerIds: ['chosen'], aliases: [], activity: 'inherit' }, message: '第一句', history: [], previewActions: true,
  })
  assert.match(app.field('trial-log').textContent, /试聊回复：第一句/)
  assert.equal(app.field('text'), textarea)
  app.input('trial-message', '第二句')
  await app.click('试聊')
  assert.equal(app.previews[1].history.length, 2)
  app.input('text', '新的人设草稿')
  app.input('trial-message', '换个人设试试')
  await app.click('试聊')
  assert.deepEqual(app.previews[2].history, [])
  assert.deepEqual(app.posts, [], '试聊不得调用人设保存或绑定')
})

test('试聊期间禁止重复请求，失败保留消息与草稿，重试后可清空试聊', async () => {
  const app = page()
  await app.open()
  const textarea = app.input('text', '试聊失败也保留')
  app.input('trial-message', '这句稍后重试')
  const finish = app.delayPreview()
  app.failPreview('模型暂不可用，请稍后重试')
  await app.click('试聊')
  assert.equal(app.field('trial-message').disabled, true)
  await app.click('试聊中…')
  assert.equal(app.previews.length, 1)
  await finish()
  assert.equal(app.field('trial-message').value, '这句稍后重试')
  assert.equal(app.field('text'), textarea)
  assert.match(app.field('trial-status').textContent, /模型暂不可用/)
  assert.equal(app.field('trial-message').disabled, false)
  app.failPreview('')
  await app.click('试聊')
  assert.match(app.field('trial-log').textContent, /这句稍后重试/)
  await app.click('清空试聊')
  assert.equal(app.field('trial-log').textContent, '')
  assert.deepEqual(app.posts, [])
})

test('昵称与人设档位：轮询保留草稿，保存归一化昵称并携带档位', async () => {
  const app = page()
  await app.open()
  const aliases = app.input('aliases', '鱼鱼，小鱼 鱼鱼')
  const activity = app.field('activity')
  activity.value = 'active'; activity.emit('change')
  app.document.activeElement = null
  await app.context.load()
  assert.equal(app.field('aliases'), aliases)
  assert.equal(app.field('aliases').value, '鱼鱼，小鱼 鱼鱼')
  assert.equal(app.field('activity').value, 'active')
  await app.click('保存')
  assert.deepEqual(app.posts[0].aliases, ['鱼鱼', '小鱼'])
  assert.equal(app.posts[0].activity, 'active')
})

test('昵称限制：不足2字或超过8个不能提交，错误保留草稿', async () => {
  const app = page()
  await app.open()
  app.input('aliases', '鱼')
  await app.click('保存')
  assert.equal(app.posts.length, 0)
  assert.match(app.notices.at(-1), /2–20/)
  app.input('aliases', Array.from({ length: 9 }, (_, i) => `昵称${i}`).join(','))
  await app.click('保存')
  assert.equal(app.posts.length, 0)
  assert.equal(app.field('text').value, '旧人设内容')
})

test('图文预演：图库图片可单独提交，空文字回复仍渲染图片动作和警告', async () => {
  const id = 'a'.repeat(64)
  const chatKey = 'onebot:fixture:group:test'
  const app = page({ chatKey, stickerIds: [id], items: [{ id, desc: '开心小鱼', tags: ['开心'], state: 'library' }], actions: [{ type: 'sticker', id, desc: '开心小鱼', available: true }] })
  await app.open()
  app.field('trial-sticker').value = id; app.field('trial-sticker').emit('change')
  await app.click('试聊')
  assert.equal(app.previews.length, 0, '使用图库图前要求选择对话范围')
  app.field('trial-chat').value = chatKey; app.field('trial-chat').emit('change')
  await app.click('试聊')
  assert.equal(app.previews[0].message, '')
  assert.equal(app.previews[0].imageStickerId, id)
  assert.equal(app.previews[0].chatKey, chatKey)
  assert.equal(app.previews[0].previewActions, true)
  assert.ok(find(app.field('trial-log'), node => node.tagName === 'IMG'))
  assert.match(app.field('trial-log').textContent, /仅图文预演/)
  assert.deepEqual(app.posts, [])
})

test('图文预演：不可用图片只显示原因，不请求缩略图', async () => {
  const app = page({ actions: [{ type: 'sticker', id: 'missing', desc: '缺失图片', available: false, reason: '当前群不可用' }] })
  await app.open(); app.input('trial-message', '发一张图')
  await app.click('试聊')
  assert.match(app.field('trial-log').textContent, /当前群不可用/)
  assert.equal(find(app.field('trial-log'), node => node.tagName === 'IMG'), null)
})

test('本地样例：手动保存加载删除，不访问服务器且最多10条', async () => {
  const app = page()
  await app.open(); app.input('trial-message', '保存这个测试问题')
  await app.click('保存为样例')
  const key = 'dsh-qq.persona-trial-cases.v1'
  const rows = JSON.parse(app.local.get(key))
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'imageStickerId', 'message'])
  assert.deepEqual(app.previews, [])
  app.input('trial-message', '另一句')
  app.field('trial-cases').value = rows[0].id
  await app.click('加载样例')
  assert.equal(app.field('trial-message').value, '保存这个测试问题')
  await app.click('删除样例')
  assert.deepEqual(JSON.parse(app.local.get(key)), [])
  app.context.personaTrial.cases = Array.from({ length: 10 }, (_, i) => ({ id: String(i), message: '测试', imageStickerId: '' }))
  await app.click('保存为样例')
  assert.match(app.field('trial-status').textContent, /最多保存 10/)
  assert.deepEqual(app.posts, [])
})

test('图库轮询：编辑期间不重建节点，只更新补全进度', () => {
  const app = page()
  app.useFunctions(['stickerTaggingText', 'renderStickers'])
  const host = app.roots.get('stickers')
  const editor = new Element('textarea')
  editor.value = '正在输入的中文说明'
  const status = new Element('div'); status.id = 'sticker-tagging-status'
  host.appendChild(editor); host.appendChild(status)
  app.context.stickerEditors = { fixture: { node: editor } }
  app.context.S.stickers = { tagging: { running: true, pending: 2, completed: 3, failed: 1 } }
  app.context.renderStickers('poll')
  assert.equal(host.children[0], editor)
  assert.equal(editor.value, '正在输入的中文说明')
  assert.match(status.textContent, /等待 2.*完成 3.*失败 1/)
})

test('诊断：中文原因、耗时与展开状态在刷新后保留', () => {
  const app = page()
  app.useFunctions(['skippedLabel', 'renderDiagnostics'])
  app.context.S.diagnostics = { recent: [{ id: 'd1', chatKey: 'mock:a:group:g', at: Date.now() - 3000, status: 'ignored', reason: 'addressed-other', durationMs: 1200, steps: [{ at: Date.now(), status: 'ignored', reason: 'addressed-other' }] }] }
  const host = app.roots.get('chat-control')
  app.context.renderDiagnostics(host)
  const detail = find(host, node => node.tagName === 'DETAILS')
  assert.equal(detail.open, false)
  assert.match(host.textContent, /正在对其他群友说话/)
  assert.match(host.textContent, /耗时 1.2 秒/)
  detail.open = true; detail.emit('toggle'); host.textContent = ''
  app.context.renderDiagnostics(host)
  assert.equal(find(host, node => node.tagName === 'DETAILS').open, true)
})
