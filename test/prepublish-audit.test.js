import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const audit = fileURLToPath(new URL('../scripts/prepublish-audit.sh', import.meta.url))
function isolatedEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  // Git hooks export repository locations and config overrides. cwd alone cannot
  // isolate a fixture: every child, including audit's Bash/Node descendants,
  // must lose all GIT_* variables before it can initialize or write a repository.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  delete env.NODE_TEST_CONTEXT
  return env
}
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-qq-audit-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const write = (name, text) => { const path = join(cwd, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: isolatedEnv() })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  write('package.json', '{"type":"module"}')
  write('test/plugin.test.js', "import { test } from 'node:test'; test('plugin', () => {})\n")
  write('lib/plugin.js', '// OneBot / NapCat and QQBot are published together.\n')
  mkdirSync(join(cwd, 'scripts'))
  copyFileSync(audit, join(cwd, 'scripts/prepublish-audit.sh'))
  const commit = () => { git('add', '.'); git('-c', 'user.name=Audit Test', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  const run = (ref = 'HEAD', env = {}) => {
    const result = spawnSync('bash', ['scripts/prepublish-audit.sh', ref], { cwd, encoding: 'utf8', env: isolatedEnv(env) })
    return { code: result.status, text: result.stdout + result.stderr }
  }
  return { cwd, write, git, commit, run }
}

test('发布审计：完整两端代码可通过，设置旧跳过变量也不能绕过失败测试', t => {
  const env = fixture(t)
  env.commit()
  const passed = env.run()
  assert.equal(passed.code, 0, passed.text)
  assert.match(passed.text, /完整测试通过/)
  assert.match(passed.text, /# tests 1;# pass 1;# fail 0;# skipped 0/)
  env.write('test/plugin.test.js', "import { test } from 'node:test'; test('broken', () => { throw Error('failure') })\n")
  env.commit()
  const failed = env.run('HEAD', { SKIP_TESTS: '1', SKIP_AUDIT: '1' })
  assert.equal(failed.code, 1)
  assert.match(failed.text, /完整测试失败/)
})

test('发布审计：无效ref、旧ref、未追踪文件与脏工作树均不能错测', t => {
  const env = fixture(t), first = env.commit()
  assert.match(env.run('missing-ref').text, /无效的提交引用/)
  assert.equal(env.run('missing-ref').code, 1)
  env.write('lib/plugin.js', '// changed\n')
  assert.equal(env.run().code, 1)
  env.commit()
  assert.equal(env.run(first).code, 1)
  env.write('lib/extra.js', '// untracked\n')
  assert.equal(env.run().code, 1)
})

test('发布审计：目录与文件白名单必须精确匹配', t => {
  for (const path of ['lib-backup/private.js', 'README.md.bak', 'test/store.v4.json']) {
    const env = fixture(t)
    env.write(path, '{}')
    env.commit()
    const result = env.run()
    assert.equal(result.code, 1, path)
    assert.match(result.text, /白名单外|不应发布/)
  }
})

test('发布审计：密钥与开发机路径失败，日志不复述值', t => {
  const cases = ['ghp_' + 'x'.repeat(24), ['', 'home', 'example', 'private'].join('/')]
  for (const value of cases) {
    const env = fixture(t)
    env.write('lib/example.js', `// ${value}\n`)
    env.commit()
    const result = env.run()
    assert.equal(result.code, 1)
    assert.ok(!result.text.includes(value))
  }
})

test('发布审计：符号链接不能替代受审计源码', t => {
  const env = fixture(t)
  symlinkSync('plugin.js', join(env.cwd, 'lib/link.js'))
  env.commit()
  const result = env.run()
  assert.equal(result.code, 1)
  assert.match(result.text, /符号链接/)
})

test('发布审计：真实hook环境下临时仓库不修改外层refs、index、objects或config', t => {
  const outer = fixture(t)
  outer.commit()
  const gitDir = join(outer.cwd, '.git')
  function snapshot(dir) {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name,
      entry.isDirectory() ? snapshot(join(dir, entry.name)) : createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex'),
    ]))
  }
  const before = snapshot(gitDir)
  // Run the existing pass/fail fixtures in a genuine child process whose actual
  // environment matches pre-push, rather than passing a mock env to a helper.
  const env = {
    ...isolatedEnv(),
    GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_WORK_TREE: outer.cwd,
    GIT_INDEX_FILE: join(gitDir, 'index'), GIT_PREFIX: 'test/', GIT_NAMESPACE: 'outer',
    GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, 'objects'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', '^发布审计：完整两端代码可通过', fileURLToPath(import.meta.url)], {
    cwd: outer.cwd, encoding: 'utf8', env, timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 1/)
  assert.deepEqual(snapshot(gitDir), before, '外层仓库的全部Git元数据必须逐文件保持不变')
})
