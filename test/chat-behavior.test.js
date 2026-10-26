import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityNote, isAliasAddressed, normalizeActivity, normalizeAliases, participationSettings, stickerSendSettings } from '../lib/chat-behavior.js'

test('昵称严格校验、宽容加载与字符边界', () => {
  assert.deepEqual(normalizeAliases([' 鱼鱼 ', '鱼鱼', '蓝色大肥鱼'], { strict: true }), ['鱼鱼', '蓝色大肥鱼'])
  assert.deepEqual(normalizeAliases(['🐟🐟'], { strict: true }), ['🐟🐟'])
  for (const value of [null, '鱼鱼', ['鱼'], ['鱼'.repeat(21)], ['鱼\n鱼'], ['鱼\u202e鱼'], [42], Array.from({ length: 9 }, (_, i) => `昵称${i}`)]) {
    assert.throws(() => normalizeAliases(value, { strict: true }), /昵称/)
  }
  assert.deepEqual(normalizeAliases([null, '鱼', ' 鱼鱼 ', '鱼\n鱼', '鱼鱼']), ['鱼鱼'])
  assert.equal(normalizeActivity('bad'), 'inherit')
  assert.throws(() => normalizeActivity('bad', { strict: true }), /档位/)
})

test('只有明确呼唤昵称才匹配，不把普通提及或正则字符当作召唤', () => {
  const aliases = ['鱼鱼', '蓝色大肥鱼', '肥鱼', '小[鱼]']
  for (const text of ['鱼鱼出来', '鱼鱼，你怎么看', '在吗，鱼鱼', '鱼鱼', '鱼鱼！', '鱼鱼 你能帮我吗', '出列，说话，蓝色大肥鱼', '小[鱼]，你怎么看']) {
    assert.equal(isAliasAddressed(text, aliases), true, text)
  }
  for (const text of ['刚才鱼鱼说过', '鱼鱼今天没来', '肥鱼好吃', '鱼鱼出来了', '鱼鱼鱼出来', '我说在吗，鱼鱼', '小鱼，你怎么看', '鱼鱼，今天没来']) {
    assert.equal(isAliasAddressed(text, aliases), false, text)
  }
})

test('活跃档位只调整主动阈值和冷却，不启用关闭的功能或改硬额度', () => {
  const participation = { enabled: false, mode: 'off', threshold: 0.55, cooldownMs: 120000, dailyWakeLimit: 3, quietHours: '23:00-08:00' }
  const sticker = { enabled: false, cooldownMs: 30000, perTurnMax: 2, dailyPerChat: 30, duplicateTtlMs: 1234 }
  for (const activity of ['inherit', 'normal']) {
    assert.deepEqual(participationSettings(participation, activity), participation)
    assert.deepEqual(stickerSendSettings(sticker, activity), sticker)
    assert.equal(activityNote(activity), '')
  }
  for (const [activity, threshold, factor] of [['quiet', 0.6, 2], ['active', 0.45, 0.5]]) {
    assert.deepEqual(participationSettings(participation, activity), { ...participation, threshold, cooldownMs: 120000 * factor })
    assert.deepEqual(stickerSendSettings(sticker, activity), { ...sticker, cooldownMs: 30000 * factor })
    assert.equal(stickerSendSettings({ cooldownMs: 0, dailyPerChat: 0 }, activity).cooldownMs, 0)
    assert.equal(participationSettings({ cooldownMs: 0 }, activity).cooldownMs, 0)
    assert.equal(stickerSendSettings({}, activity).cooldownMs, 30000 * factor)
    assert.ok(activityNote(activity).length > 0)
  }
  assert.equal(participationSettings({ threshold: 0 }, 'active').threshold, 0)
  assert.equal(participationSettings({ threshold: 1 }, 'quiet').threshold, 1)
  assert.equal(participation.threshold, 0.55)
  assert.equal(sticker.cooldownMs, 30000)
})
