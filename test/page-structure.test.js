/**
 * 控制台页面结构回归：导航项与卡片顺序必须一致。
 *
 * 历史 bug：活动量/Token 消耗卡被插在页面中间，但导航里排在配置之后；scroll-spy 按导航顺序
 * 找「最后一个越过顶部的段落」，于是滚到群记忆/配置时高亮却跳到 Token 消耗。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const html = await readFile(new URL('../lib/page.html', import.meta.url), 'utf8')

test('导航项顺序与卡片 DOM 顺序一致，且每个 data-sec 都能找到对应卡片', () => {
  const nav = [...html.matchAll(/class="nav-item[^"]*"[^>]*data-sec="(sec-[^"]+)"/g)].map(match => match[1])
  const sections = [...html.matchAll(/<section class="card" id="(sec-[^"]+)">/g)].map(match => match[1])
  assert.ok(nav.length >= 10, `导航项数量异常：${nav.length}`)
  assert.equal(new Set(nav).size, nav.length, '导航项不得重复')

  for (const id of nav) {
    if (id === 'sec-overview') continue // 概览卡没有独立 section（顶部 hero）
    assert.ok(sections.includes(id), `导航项 ${id} 没有对应 section`)
  }
  // 只比较「两边都有」的顺序：概览不在 section 列表里
  const comparable = nav.filter(id => sections.includes(id))
  assert.deepEqual(comparable, sections, '导航顺序与页面卡片顺序不一致（scroll-spy 会错配高亮）')
})

test('群笔记 GET 不得传空对象（第二个参数存在即 POST）', () => {
  // 历史 bug：打开群笔记编辑器时传了 {} → GET 变 POST → 后端报「文件名不合法」
  assert.doesNotMatch(
    html,
    /api\('\/dsh-qq\/api\/groups\/note\?file=[^']*'\s*,\s*\{\s*\}\s*\)/,
    'GET 必须只传一个参数：api(path)',
  )
})

test('scroll-spy 按文档位置排序（防止再次按导航顺序错配）', () => {
  assert.match(html, /sort\(function \(a, b\) \{ return a\.sec\.offsetTop - b\.sec\.offsetTop; \}\)/, 'scroll-spy 必须按 offsetTop 排序')
  assert.match(html, /atBottom/, '滚到底部应高亮最后一段')
})
