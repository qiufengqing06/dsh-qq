import assert from 'node:assert/strict'
import { test } from 'node:test'

function loadClient() {
  let loaded = null
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: definition => { loaded = definition } } }
  return import(`../lib/client.js?test=${Date.now()}-${Math.random()}`).then(() => {
    globalThis.window = previous
    assert.ok(loaded, 'client module must register through __ModuleLoader__')
    return loaded
  })
}

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
    }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    createPortal: node => node,
    Fragment: Symbol('Fragment'),
  }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function find(node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.type === type) return node
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) {
    const hit = find(child, type)
    if (hit !== null) return hit
  }
  return null
}

test('鱼书：设置页分区替代侧栏按钮，内嵌 /dsh-qq', async () => {
  const definition = await loadClient()
  const client = definition.factory(fakeReact)
  const registrations = []
  const injected = []
  const ctx = { slots: {
    inject(name, register) { injected.push(name); return register() },
    register(meta, component) { registrations.push({ meta, component }); return () => {} },
  } }
  assert.deepEqual(client.inject, ['slots'])
  client.apply(ctx)
  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registrations.length, 1)
  const [{ meta, component }] = registrations
  assert.equal(meta.name, 'settings.section')
  assert.equal(meta.id, 'dsh-qq-console')
  assert.equal(meta.label(), '鱼书')
  const tree = component({})
  assert.match(textOf(tree), /鱼书/)
  assert.match(textOf(tree), /点击后用独立弹窗打开/)
  assert.equal(find(tree, 'iframe'), null, '设置分区本身不内嵌 iframe')
  assert.equal(find(tree, 'button').props.title, '打开鱼书控制台')
  assert.equal(find(tree, 'a').props.href, '/dsh-qq')
  assert.doesNotMatch(JSON.stringify(tree), /QQ 控制台/)
})
