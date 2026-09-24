import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply, getPluginHandle } from '../lib/index.js'
import { createFakeAgents } from './helpers/fake-ctx.js'

/**
 * 真实 cordis 集成测试 —— 这是假 ctx 测不出的那一层：
 * ① cordis 的 `safeCollect` 只接受函数 / 空 / 可迭代作为 effect，插件 apply 返回普通对象
 *    会抛 `TypeError: Invalid effect`（真实踩过一次：插件页显示「启用失败」）；
 * ② `ctx.effect` / `ctx.inject` 的回调返回值同样要满足该契约；
 * ③ 真实 fiber 的 dispose 语义（卸载后注册表/监听器必须清干净）。
 *
 * cordis 不在本包依赖里（DSH 插件运行时由宿主提供），因此按 DSH 检出位置动态定位；
 * 找不到时跳过，不阻塞纯离线环境。
 */
/**
 * 定位 cordis：优先环境变量，其次从常见 DSH 检出位置猜（含本仓库的兄弟目录），
 * 都没有就跳过。**不写死开发机的绝对路径**——那既泄漏本机结构，换台机器也跑不了。
 */
function resolveCordisEntry() {
  const candidates = []
  if (process.env.DSH_CORDIS_ENTRY) candidates.push(process.env.DSH_CORDIS_ENTRY)
  const harnessRoots = [process.env.DSH_CHECKOUT, process.env.DSH_HOME, process.cwd()]
  for (const root of harnessRoots) {
    if (typeof root === 'string' && root !== '') {
      candidates.push(join(root, 'vendor/cordis/lib/index.js'))
      candidates.push(join(root, '..', 'deepseek-harness/vendor/cordis/lib/index.js'))
    }
  }
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0] ?? ''
}
const CORDIS_ENTRY = resolveCordisEntry()
const HAS_CORDIS = CORDIS_ENTRY !== '' && existsSync(CORDIS_ENTRY)

test('真实 cordis：插件能装配、注册命令与渠道条目、卸载后清理干净', async t => {
  if (!HAS_CORDIS) return t.skip(`未找到 cordis：${CORDIS_ENTRY}`)
  const { Context } = await import(pathToFileURL(CORDIS_ENTRY).href)

  const ctx = new Context()
  const registeredCommands = []
  const logs = { warn: [] }
  ctx.provide('agents', createFakeAgents())
  ctx.provide('commands', {
    register(definition) {
      registeredCommands.push(definition.name)
      return () => {
        const index = registeredCommands.indexOf(definition.name)
        if (index >= 0) registeredCommands.splice(index, 1)
      }
    },
  })
  ctx.provide('logger', { info: () => {}, warn: line => logs.warn.push(String(line)), error: () => {} })

  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-cordis-'))
  // ctx.plugin 返回 fiber（可 await 等待加载完成，用 fiber.dispose() 卸载）
  const fiber = await ctx.plugin((await import('../lib/index.js')).default, {
    transport: 'mock',
    autoConnect: false,
    dataDir: dir,
  })
  assert.equal(typeof fiber?.dispose, 'function', '插件条目应可卸载')
  assert.equal(registeredCommands.length, 15, '15 条 /qq-* 命令应注册到 ctx.commands')
  assert.ok(globalThis.__dshChannelNotify?.qq !== undefined, '渠道注册表应登记 qq 条目')

  // 经 ctx.plugin 挂载时，apply 拿到的是子上下文；fiber.ctx 指向它
  const handle = getPluginHandle(fiber.ctx ?? ctx)
  assert.ok(handle !== undefined, '句柄应可通过 getPluginHandle(ctx) 取得')
  assert.equal(handle.transport.kind, 'mock')

  // 走一遍入站链路（真实 cordis 的 on/effect 语义）
  await handle.store.setHomeChannel('owner-1')
  await handle.router.routeInbound(
    handle.transport.injectText('/qq-help', { target: { kind: 'dm', userId: 'owner-1' }, sender: { id: 'owner-1', name: 'O' } }),
  )
  await handle.router.routeInbound(
    handle.transport.injectText('ping', { target: { kind: 'dm', userId: 'owner-1' }, sender: { id: 'owner-1', name: 'O' } }),
  )
  const sessionId = handle.bridge.currentSession('mock:mock:dm:owner-1')
  assert.ok(sessionId.startsWith('qq-'), `应创建 DSH 会话，实际 ${sessionId}`)

  await fiber.dispose()
  assert.ok(globalThis.__dshChannelNotify?.qq === undefined, '卸载后渠道注册表条目应被清理')
  assert.equal(registeredCommands.length, 0, '卸载后命令应全部注销')
  await ctx.dispose?.()
})

test('真实 cordis：apply 的返回值必须是合法 effect（不能是普通对象）', async t => {
  if (!HAS_CORDIS) return t.skip(`未找到 cordis：${CORDIS_ENTRY}`)
  const { Context } = await import(pathToFileURL(CORDIS_ENTRY).href)
  const ctx = new Context()
  ctx.provide('agents', createFakeAgents())
  ctx.provide('logger', { info: () => {}, warn: () => {}, error: () => {} })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-cordis-'))

  // apply 直接调用：返回值应为 disposer 函数（旧实现返回句柄对象 → 真实 cordis 会报 Invalid effect）
  const result = await apply(ctx, { transport: 'mock', autoConnect: false, dataDir: dir })
  assert.equal(typeof result, 'function', 'apply 必须返回函数（cordis effect 契约）')
  assert.equal(getPluginHandle(ctx)?.transport?.kind, 'mock', '句柄改由 getPluginHandle 暴露')
  await result()
  await ctx.dispose?.()
})
