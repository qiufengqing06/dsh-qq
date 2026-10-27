/**
 * 配置校验：M5（OneBot 默认不允许连公网）+ pricing 价格表。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isLocalEndpoint, resolveConfig } from '../lib/config.js'

test('isLocalEndpoint：回环/私网/单段主机名放行，公网域名与公网 IP 拒绝', () => {
  for (const url of [
    'ws://127.0.0.1:3001',
    'ws://localhost:3001',
    'ws://192.168.1.10:3001',
    'ws://172.22.92.154:3001',
    'ws://10.0.0.5:3001',
    'ws://[::1]:3001',
    'ws://napcat:3001',
  ]) {
    assert.equal(isLocalEndpoint(url), true, url)
  }
  for (const url of ['ws://napcat.example.com:3001', 'ws://8.8.8.8:3001', 'ws://[2001:db8::1]:3001']) {
    assert.equal(isLocalEndpoint(url), false, url)
  }
  assert.equal(isLocalEndpoint('not a url'), false)
})

test('resolveConfig：公网 wsUrl 默认拒绝，onebot.allowRemote 显式放行', () => {
  assert.throws(
    () => resolveConfig({ transport: 'onebot', onebot: { wsUrl: 'ws://napcat.example.com:3001' } }),
    /allowRemote/,
  )
  const allowed = resolveConfig({ transport: 'onebot', onebot: { wsUrl: 'wss://napcat.example.com:3001', allowRemote: true } })
  assert.equal(allowed.onebot.allowRemote, true)
  assert.equal(allowed.onebot.wsUrl, 'wss://napcat.example.com:3001')
  // 私网/回环不需要开关
  const local = resolveConfig({ transport: 'onebot', onebot: { wsUrl: 'ws://127.0.0.1:3001' } })
  assert.equal(local.onebot.allowRemote, false)
})

test('pricing：默认关闭换算；非负数校验；未知键报错', () => {
  assert.deepEqual(resolveConfig({ transport: 'mock' }).pricing, { inputPerMillion: 0, outputPerMillion: 0 })
  const priced = resolveConfig({ transport: 'mock', pricing: { inputPerMillion: 2, outputPerMillion: 8 } })
  assert.deepEqual(priced.pricing, { inputPerMillion: 2, outputPerMillion: 8 })
  assert.throws(() => resolveConfig({ transport: 'mock', pricing: { inputPerMillion: -1 } }), /非负/)
  assert.throws(() => resolveConfig({ transport: 'mock', pricing: { nope: 1 } }), /未知/)
})

test('napcat.enabled 必须是布尔值（字符串 / 数字不再静默变成关闭）', () => {
  assert.throws(() => resolveConfig({ transport: 'onebot', napcat: { enabled: 'true' } }), /napcat\.enabled must be a boolean/)
  assert.throws(() => resolveConfig({ transport: 'onebot', napcat: { enabled: 1 } }), /napcat\.enabled must be a boolean/)
  assert.equal(resolveConfig({ transport: 'onebot', napcat: { enabled: false } }).napcat.enabled, false)
  assert.equal(resolveConfig({ transport: 'onebot' }).napcat.enabled, true)
})

test('media 配置：白名单/私网/token/重定向上限', () => {
  const config = resolveConfig({
    media: {
      allowedHosts: ['192.168.1.5:8080', '*.example.com'],
      allowPrivateHosts: true,
      tokenHosts: ['cdn.example.com'],
      maxRedirects: 2,
    },
  })
  assert.deepEqual(config.media.allowedHosts, ['192.168.1.5:8080', '*.example.com'])
  assert.equal(config.media.allowPrivateHosts, true)
  assert.deepEqual(config.media.tokenHosts, ['cdn.example.com'])
  assert.equal(config.media.maxRedirects, 2)

  assert.throws(() => resolveConfig({ media: { allowedHosts: 'x' } }), /media\.allowedHosts must be an array/)
  assert.throws(() => resolveConfig({ media: { maxRedirects: 11 } }), /media\.maxRedirects/)
  assert.throws(() => resolveConfig({ media: { allowPrivateHosts: 'yes' } }), /media\.allowPrivateHosts must be a boolean/)
  assert.throws(() => resolveConfig({ media: { nope: 1 } }), /media has unknown keys/)
})

test('schedules 配置：安静时段、每日上限、tick 校验', () => {
  const config = resolveConfig({ transport: 'mock', schedules: { quietHours: '23:30-07:30', dailyLimitPerChat: 2, tickMs: 5000 } })
  assert.equal(config.schedules.quietHours, '23:30-07:30')
  assert.equal(config.schedules.dailyLimitPerChat, 2)
  assert.equal(config.schedules.tickMs, 5000)
  assert.throws(() => resolveConfig({ transport: 'mock', schedules: { quietHours: '23:00' } }), /quietHours/)
  assert.throws(() => resolveConfig({ transport: 'mock', schedules: { dailyLimitPerChat: -1 } }), /dailyLimitPerChat/)
  assert.throws(() => resolveConfig({ transport: 'mock', schedules: { enabled: 'yes' } }), /schedules\.enabled must be a boolean/)
})

test('participation 配置：默认关、log/block、阈值/安静时段校验', () => {
  const config = resolveConfig({ transport: 'mock' })
  assert.equal(config.participation.enabled, false)
  assert.equal(config.participation.mode, 'log')
  assert.equal(config.participation.allowUnmentioned, false)
  const block = resolveConfig({ transport: 'mock', participation: { enabled: true, mode: 'block', allowUnmentioned: true, threshold: 0.6, quietHours: '22:00-07:00' } })
  assert.equal(block.participation.mode, 'block')
  assert.equal(block.participation.threshold, 0.6)
  assert.equal(block.participation.allowUnmentioned, true)
  assert.throws(() => resolveConfig({ transport: 'mock', participation: { threshold: 2 } }), /threshold/)
  assert.throws(() => resolveConfig({ transport: 'mock', participation: { mode: 'sometimes' } }), /participation.mode/)
  assert.throws(() => resolveConfig({ transport: 'mock', participation: { quietHours: '22:00' } }), /quietHours/)
})

test('affection 配置：默认关、保留天数/人数校验', () => {
  const config = resolveConfig({ transport: 'mock' })
  assert.equal(config.affection.enabled, false)
  assert.equal(config.affection.retentionDays, 30)
  const on = resolveConfig({ transport: 'mock', affection: { enabled: true, retentionDays: 7, maxPeoplePerGroup: 10 } })
  assert.equal(on.affection.enabled, true)
  assert.equal(on.affection.retentionDays, 7)
  assert.throws(() => resolveConfig({ transport: 'mock', affection: { enabled: 'yes' } }), /affection\.enabled/)
  assert.throws(() => resolveConfig({ transport: 'mock', affection: { retentionDays: 0 } }), /retentionDays/)
})

test('groupOpen：默认开、必须布尔', () => {
  assert.equal(resolveConfig({ transport: 'mock' }).groupOpen, true)
  assert.equal(resolveConfig({ transport: 'mock', groupOpen: false }).groupOpen, false)
  assert.throws(() => resolveConfig({ transport: 'mock', groupOpen: 'no' }), /groupOpen must be a boolean/)
})

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

test('stickers.vision：默认 deepseek-flash、可关、校验字段', () => {
  const config = resolveConfig({ transport: 'mock' })
  assert.equal(config.stickers.vision.enabled, true)
  assert.equal(config.stickers.vision.provider, 'deepseek-account')
  assert.equal(config.stickers.vision.model, 'deepseek-flash')
  const off = resolveConfig({ transport: 'mock', stickers: { vision: { enabled: false, model: 'deepseek-pro' } } })
  assert.equal(off.stickers.vision.enabled, false)
  assert.equal(off.stickers.vision.model, 'deepseek-pro')
  assert.throws(() => resolveConfig({ transport: 'mock', stickers: { vision: { unknown: 1 } } }), /stickers\.vision has unknown keys/)
})

test('promptMaxChars：默认 5000，可配置且校验范围', () => {
  assert.equal(resolveConfig({ transport: 'mock' }).promptMaxChars, 5000)
  assert.equal(resolveConfig({ transport: 'mock', promptMaxChars: 8000 }).promptMaxChars, 8000)
  assert.throws(() => resolveConfig({ transport: 'mock', promptMaxChars: 99 }), /promptMaxChars/)
  assert.throws(() => resolveConfig({ transport: 'mock', promptMaxChars: 100001 }), /promptMaxChars/)
})
