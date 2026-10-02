import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { t, savedLanguage, saveLanguage, languageValue } from '../src/i18n.mts'
import { parseCommand } from '../src/commands.mts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)

test('localization preserves command IDs and arbitrary plugin output', () => {
  assert.equal(t('zh', 'Running'), '运行中')
  assert.equal(t('en', 'Running'), 'Running')
  assert.equal(t('zh', 'Starting me.init {version}', { version: 'Rc2' }), '正在启动me.init Rc2')
  assert.equal(t('zh', 'arbitrary plugin output'), 'arbitrary plugin output')
  assert.deepEqual(parseCommand('/start me.cli', 'zh'), { method: 'start', plugin: 'me.cli' })
  assert.throws(() => parseCommand('/start', 'zh'), /用法：\/start <插件>/)
  assert.throws(() => languageValue('invalid'), /zh.*en/)
})

test('language preference is persisted and invalid data can be selected again', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'me-lang-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'testbot/cli.json')
  assert.equal(await savedLanguage(file), undefined)
  await saveLanguage(file, 'zh')
  assert.equal(await savedLanguage(file), 'zh')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { language: 'zh' })
  await writeFile(file, 'null')
  assert.equal(await savedLanguage(file), undefined)
})

test('Chinese JSON mode stays parseable and never prompts for language', { timeout: 200_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'me-lang-json-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const result = await exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'zh', '--json', 'status'], {
    env: { ...process.env, XDG_CONFIG_HOME: dir },
  })
  assert.equal(result.stderr, '')
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(frames.some(frame => frame.type === 'log' && frame.message === 'Core已就绪'))
  const status = frames.find(frame => frame.type === 'status')
  assert.equal(status.snapshot.plugins[0].state, 'Running')
  assert.ok(!result.stdout.includes('Choose language'))
  assert.ok(frames.some(frame => frame.message?.includes('资源已释放')))
})
