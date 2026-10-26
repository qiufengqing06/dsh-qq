/**
 * 控制台前端纯函数单测。
 *
 * 页面是无构建的自包含 HTML（page.html 每次请求从磁盘重读，刷新即生效），纯函数不能拆到
 * 需要后端配合注入的外部文件里。这里直接抽取 `page-format:start/end` 标记之间的真实代码，
 * 用 vm 执行——测的是线上同一份源码，不需要 DOM 或构建步骤。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const html = await readFile(new URL('../lib/page.html', import.meta.url), 'utf8')
const block = html.match(/\/\* page-format:start[^\n]*\n([\s\S]*?)\/\* page-format:end \*\//)
assert.ok(block !== null, 'page.html 必须保留 page-format:start/end 标记块')
const sandbox = {}
vm.runInNewContext(block[1] + '\n;globalThis.__pageFormat = { fmtTokens, fmtTime, relTime, chatDisplay }', sandbox)
const F = sandbox.__pageFormat

test('page-format：标记块暴露四个纯函数', () => {
  assert.deepEqual(Object.keys(F).sort(), ['chatDisplay', 'fmtTime', 'fmtTokens', 'relTime'])
})

test('fmtTokens：千/百万缩写与边界', () => {
  assert.equal(F.fmtTokens(0), '0')
  assert.equal(F.fmtTokens(999), '999')
  assert.equal(F.fmtTokens(9999), '9999')
  assert.equal(F.fmtTokens(10000), '10.0k')
  assert.equal(F.fmtTokens(12345), '12.3k')
  assert.equal(F.fmtTokens(123456), '123k')
  assert.equal(F.fmtTokens(1234567), '1.2M')
  assert.equal(F.fmtTokens(12345678), '12M')
  // 脏输入按 0 处理：页面拿到缺失字段时不应该显示 NaN
  assert.equal(F.fmtTokens(null), '0')
  assert.equal(F.fmtTokens('abc'), '0')
})

test('chatDisplay：chatKey 解析、线路标签与超长截断', () => {
  // vm 里创建的对象原型与宿主不同，按字段比较（deepEqual 会因原型不同而失败）
  const dm = F.chatDisplay('qqbot:100001:dm:OPENID')
  assert.equal(dm.kind, '官方线')
  assert.equal(dm.label, '私聊 OPENID')
  const group = F.chatDisplay('qqbot:100001:group:90001')
  assert.equal(group.kind, '官方线')
  assert.equal(group.label, '群 90001')
  const channel = F.chatDisplay('qqbot:100001:channel:GUILD:CHANNEL')
  assert.equal(channel.kind, '官方线')
  assert.equal(channel.label, 'channel GUILD:CHANNEL')

  const long = F.chatDisplay('qqbot:100001:group:' + '9'.repeat(40))
  assert.equal(long.label.length, 29)
  assert.match(long.label, /…$/)
})

test('fmtTime / relTime：空值、时间分级与外推', () => {
  assert.equal(F.fmtTime(0), '')
  assert.match(F.fmtTime(Date.UTC(2026, 0, 1, 4, 5, 6)), /^\d{1,2}:\d{2}:\d{2}$/)

  assert.equal(F.relTime(0), '—')
  const now = Date.now()
  assert.equal(F.relTime(now - 30 * 1000), '刚刚')
  assert.equal(F.relTime(now - 5 * 60 * 1000), '5 分钟前')
  assert.equal(F.relTime(now - 2 * 3600 * 1000), '2 小时前')
  assert.equal(F.relTime(now - 3 * 86400 * 1000), '3 天前')
  assert.notEqual(F.relTime(now - 10 * 86400 * 1000), '—')
})
