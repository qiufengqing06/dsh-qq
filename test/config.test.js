import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../lib/config.js'

test('表情新默认不覆盖显式的冷却、日额度或关闭设置', () => {
  const config = resolveConfig({ transport: 'mock', stickers: {
    enabled: false, send: { cooldownMs: 60_000, dailyPerChat: 10, duplicateTtlMs: 0 },
  } })
  assert.equal(config.stickers.enabled, false)
  assert.equal(config.stickers.send.cooldownMs, 60_000)
  assert.equal(config.stickers.send.dailyPerChat, 10)
  assert.equal(config.stickers.send.duplicateTtlMs, 0)
  const unlimited = resolveConfig({ transport: 'mock', stickers: { send: { cooldownMs: 0, dailyPerChat: 0 } } })
  assert.equal(unlimited.stickers.send.cooldownMs, 0)
  assert.equal(unlimited.stickers.send.dailyPerChat, 0)
})
