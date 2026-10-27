import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configureChatTools } from '../lib/chat-tools.js'

/** Small host-contract double: inherited masks, local tools and scoped guards. */
function host() {
  const scopes = new Map()
  const inherited = new Set(['read', 'web_fetch', 'bash'])
  const create = id => {
    const agent = { id }
    const state = { mode: 'ptc', allow: null, guards: new Set(), own: new Set() }
    scopes.set(agent, state)
    const tools = {
      presentAs(mode) {
        const previous = state.mode
        state.mode = mode
        return () => { state.mode = previous }
      },
      schemas(scope) {
        assert.equal(scope, agent, 'schema lookup must use the actual agent')
        return visible(scope).map(name => ({ name }))
      },
      restrict({ allow }) {
        for (const name of allow) assert.ok(inherited.has(name), `unknown inherited tool ${name}`)
        const previous = state.allow
        state.allow = new Set(allow)
        return () => { state.allow = previous }
      },
      guard(fn) {
        state.guards.add(fn)
        return () => state.guards.delete(fn)
      },
    }
    return { agent, ctx: { tools }, state }
  }
  const visible = agent => {
    const state = scopes.get(agent)
    const names = [...inherited].filter(name => state.allow === null || state.allow.has(name))
    return [...names, ...state.own, ...(state.mode === 'ptc' ? ['run_code'] : [])]
  }
  const execute = (agent, name) => {
    if (!visible(agent).includes(name)) return 'unknown'
    for (const guard of scopes.get(agent).guards) if (guard({ name, agent })) return 'denied'
    return 'allowed'
  }
  return { create, visible, execute }
}

test('chat gets native allowed tools; sibling keeps PTC and work tools; disposal restores only chat', () => {
  const runtime = host()
  const chat = runtime.create('chat')
  const work = runtime.create('work')
  const dispose = configureChatTools(chat.ctx, chat.agent, new Set(['read', 'web_fetch', 'missing', 'run_code']))

  assert.deepEqual(runtime.visible(chat.agent), ['read', 'web_fetch'])
  assert.equal(runtime.execute(chat.agent, 'read'), 'allowed')
  assert.equal(runtime.execute(chat.agent, 'bash'), 'unknown')
  assert.equal(runtime.execute(chat.agent, 'run_code'), 'unknown')
  assert.deepEqual(runtime.visible(work.agent), ['read', 'web_fetch', 'bash', 'run_code'])
  assert.equal(runtime.execute(work.agent, 'bash'), 'allowed')

  chat.state.own.add('write')
  assert.equal(runtime.execute(chat.agent, 'write'), 'denied', 'local registrations must still pass the guard')
  dispose()
  dispose()
  assert.equal(chat.state.mode, 'ptc')
  assert.equal(runtime.execute(chat.agent, 'bash'), 'allowed')
  assert.equal(chat.state.guards.size, 0)
})

test('an entirely unavailable allow list becomes an empty inherited mask, not unrestricted tools', () => {
  const runtime = host()
  const chat = runtime.create('empty')
  const dispose = configureChatTools(chat.ctx, chat.agent, ['not-installed'])
  assert.deepEqual(runtime.visible(chat.agent), [])
  assert.equal(runtime.execute(chat.agent, 'bash'), 'unknown')
  dispose()
})

test('legacy host keeps a scoped guard without invoking a partial presentation API', () => {
  let guard
  let released = 0
  const allowed = new Set(['read', 'run_code'])
  const ctx = { tools: {
    guard(fn) { guard = fn; return () => { released++ } },
    presentAs() { assert.fail('partial host must not switch presentation') },
  } }
  const dispose = configureChatTools(ctx, { id: 'legacy' }, allowed)
  allowed.add('bash')
  assert.equal(guard({ name: 'read' }), undefined)
  assert.match(guard({ name: 'bash' }), /bash/)
  assert.match(guard({ name: 'run_code' }), /run_code/)
  assert.doesNotMatch(guard({ name: 'bash' }), /切换工作模式|工作模式/)
  dispose()
  dispose()
  assert.equal(released, 1)
})

test('initialization failure rolls back native mode and guard instead of leaving a partial policy', () => {
  const runtime = host()
  const chat = runtime.create('failure')
  chat.ctx.tools.restrict = () => { throw new Error('restriction failed') }
  assert.throws(() => configureChatTools(chat.ctx, chat.agent, ['read']), /restriction failed/)
  assert.equal(chat.state.mode, 'ptc')
  assert.equal(chat.state.guards.size, 0)
})

test('missing agent or execution guard fails explicitly; no tools service is a no-op', () => {
  const runtime = host()
  const chat = runtime.create('missing')
  assert.throws(() => configureChatTools(chat.ctx, undefined, ['read']), /requires the agent scope/)
  assert.equal(chat.state.guards.size, 0)
  assert.throws(() => configureChatTools({ tools: {} }, chat.agent, ['read']), /guard is unavailable/)
  assert.doesNotThrow(configureChatTools({}, chat.agent, ['read']))
})
