import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { LogBuffer } from '../src/logs.mts'
import { parseCommand, complete } from '../src/commands.mts'
import { Screen } from '../src/screen.mts'
import { Terminal } from '../src/terminal.mts'
import { t } from '../src/i18n.mts'
import { wrap, width, clean } from '../src/display.mts'

test('long colored logs wrap without dropping text and keep the reading position during new output', () => {
  const text = '\x1b[31m[INFO]\x1b[0m  me.chatluna  ' + '完整模型输入'.repeat(50) + 'END'
  const rows = wrap(text, 40)
  assert.ok(rows.length > 2); assert.ok(rows.every(row => width(row) <= 40))
  assert.equal(rows.map(clean).join(''), clean(text))
  const screen = Object.assign(new EventEmitter(), { logs: [text], logScroll: 1, logFilter: ['INFO'], schedule: () => {}, clipboard: { cancel: () => {} } })
  Object.setPrototypeOf(screen, Screen.prototype)
  const view = screen as unknown as Screen, before = view.logRows().length
  view.appendLog(text + 'more')
  assert.equal(view.logScroll, 1 + view.wrapLog(text + 'more').length)
  assert.ok(view.logRows().length > before); assert.match(view.logRows().map(clean).join(''), /ENDmore/)
  view.appendLog('[WARN] excluded'); assert.equal(view.logRows().length, before + view.wrapLog(text + 'more').length)
})

test('log commands accept levels and quoted export paths without calling Core', () => {
  assert.deepEqual(parseCommand('/log'), { method: 'log', levels: [] })
  assert.deepEqual(parseCommand('/log failed ERROR failed'), { method: 'log', levels: ['FAILED', 'ERROR'] })
  assert.deepEqual(parseCommand('/log out "./运行日志 1.txt"'), { method: 'log', path: './运行日志 1.txt' })
  assert.deepEqual(parseCommand("/log out 'report.txt'"), { method: 'log', path: 'report.txt' })
  for (const line of ['/log unknown', '/log out', '/log out a b', '/log out "a" trailing', '/log out ""']) assert.throws(() => parseCommand(line), /Usage/)
  assert.deepEqual(complete('/log fa', []), [['FAILED'], 'fa'])
  assert.deepEqual(complete('/log FAILED e', []), [['ERROR'], 'e'])
  assert.deepEqual(complete('/log out ', []), [[], '/log out '])
  assert.match(t('zh', 'Filter logs by level, or export all retained logs (up to 1000 lines) to a new file'), /1000行/)
})

test('filtered logs continue following matching output and preserve unfiltered history', () => {
  const screen = Object.assign(new EventEmitter(), { logs: ['[INFO] old', '[FAILED] request', '[ERROR] module'], logScroll: 0,
    schedule: () => {}, clipboard: { cancel: () => {} }, errors: new Set(['module']) })
  Object.setPrototypeOf(screen, Screen.prototype)
  const view = screen as unknown as Screen
  view.filterLogs(['FAILED', 'ERROR'])
  assert.deepEqual(view.visibleLogs(), ['[FAILED] request', '[ERROR] module'])
  view.logScroll = 1
  view.appendLog('[INFO] unrelated'); assert.equal(view.logScroll, 1)
  view.appendLog('[FAILED] next'); assert.equal(view.logScroll, 2)
  view.filterLogs([]); assert.equal(view.visibleLogs().length, 5); assert.equal(view.logScroll, 0)
  assert.ok(view.errors.has('module'))
})

test('export retains source, severity and full timestamps without ANSI or clobbering files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'me-cli-logs-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const logs = new LogBuffer(), file = path.join(directory, '运行日志.txt')
  logs.append({ type: 'log', level: 'FAILED', time: '2026-10-03T10:00:00.000Z', source: 'me.chatluna', message: '\x1b[31m请求失败\x1b[0m\n第二行' })
  logs.append({ type: 'log', level: 'info', time: '2026-10-03T10:01:00.000Z', source: 'me.init', message: 'collected' })
  assert.equal(logs.select(['FAILED']).length, 2)
  const result = await logs.export(file), text = await readFile(file, 'utf8')
  assert.equal(result.count, 3); assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.match(text, /\[FAILED\] 2026-10-03T10:00:00.000Z  me.chatluna/); assert.match(text, /\[INFO\].*me.init.*collected/)
  assert.doesNotMatch(text, /\x1b/)
  await assert.rejects(logs.export(file), { code: 'EEXIST' }); assert.equal(await readFile(file, 'utf8'), text)
  await assert.rejects(logs.export(path.join(directory, 'missing', 'file.txt')), { code: 'ENOENT' })
  for (let i = 0; i < 1005; i++) logs.append({ type: 'log', level: 'info', time: '', source: 'plugin', message: String(i) })
  assert.equal(logs.entries.length, 1000); assert.equal(logs.entries[0].message, '5')
})

test('JSON mode collects logs for filtered snapshots instead of discarding them', () => {
  const terminal = new Terminal(true, true, false), output: string[] = []
  terminal.write = value => { output.push(value) }
  for (const level of ['info', 'failed', 'error']) terminal.log({ type: 'log', level, time: '', source: 'plugin', message: level })
  terminal.showLogs(['FAILED'])
  const filtered = JSON.parse(output.at(-1)!)
  assert.equal(filtered.type, 'logs'); assert.deepEqual(filtered.logs.map((entry: any) => entry.level), ['failed'])
  assert.equal(terminal.logBuffer.entries.length, 3)
  const count = output.length
  terminal.log({ type: 'log', level: 'info', time: '', source: 'plugin', message: 'hidden' })
  assert.equal(output.length, count); assert.equal(terminal.logBuffer.entries.length, 4)
  terminal.page('console')
  terminal.log({ type: 'log', level: 'info', time: '', source: 'plugin', message: 'visible again' })
  assert.equal(output.length, count + 1)
})

test('CLI routes filtering and export locally and reports export failures as FAILED', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'me-cli-log-command-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'plugins.json'), file = path.join(directory, 'logs with spaces.txt')
  await writeFile(config, JSON.stringify({ plugins: [] }))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  let output = ''
  try {
    await promisify(execFile)(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'zh', '--json', '--config', config,
      '-c', '/invalid', '-c', '/log FAILED ERROR', '-c', `/log out "${file}"`, '-c', `/log out "${file}"`], { cwd: directory, timeout: 55000 })
    assert.fail('invalid commands must produce a nonzero exit')
  } catch (error: any) { assert.equal(error.code, 1); output = error.stdout }
  const frames = output.trim().split('\n').map(line => JSON.parse(line)), filtered = frames.find(frame => frame.type === 'logs')
  assert.ok(filtered.logs.some((entry: any) => entry.level === 'failed' && entry.source === 'me.cli'))
  assert.ok(filtered.logs.every((entry: any) => ['failed', 'error'].includes(entry.level)))
  assert.ok(frames.some(frame => frame.type === 'log' && frame.level === 'ok' && frame.message.includes('已导出')))
  assert.ok(frames.some(frame => frame.type === 'log' && frame.level === 'failed' && frame.message.includes('日志导出失败')))
  assert.ok(!frames.some(frame => frame.type === 'log' && frame.level === 'error' && frame.source === 'me.cli'))
  const text = await readFile(file, 'utf8')
  assert.match(text, /\[INFO\].*core/); assert.match(text, /\[FAILED\].*me.cli.*invalid/)
})
