import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Screen } from '../src/screen.mts'
import { Terminal } from '../src/terminal.mts'
import { VERSION } from '../src/commands.mts'
import { clean } from '../src/display.mts'
import type { Snapshot } from '../src/protocol.mts'

function fixture(): Screen {
  const screen = Object.assign(new EventEmitter(), {
    closed: false, language: 'zh', color: true, version: VERSION, page: 'console', ready: true,
    line: '', cursor: 0, previous: [], previousCursor: '', consoleLines: [], consoleScroll: 0,
    logs: [], logScroll: 0, stateScroll: 0, errors: new Set<string>(),
    frame: [], clipboard: { cancel: () => {}, copy: async () => 'confirmed', close: () => {} }, history: [], historyIndex: -1, draft: '', completionIndex: 0, completionQuery: '', dismissedCompletion: '',
    snapshot: { version: 'b1-Rc1', state: 'running', stats: { Plugins: 2, Services: 2, Resources: 12, Dirty: 0 }, plugins: [
      { id: 'me.cli', state: 'Running', enabled: true, generation: 2, missing: [], resources: [] },
      { id: 'me.init', state: 'Running', enabled: true, generation: 1, missing: [], resources: [] },
    ] } satisfies Snapshot,
    schedule: () => {},
  })
  Object.setPrototypeOf(screen, Screen.prototype)
  return screen as unknown as Screen
}

function render(screen: Screen): string {
  const original = process.stdout.write
  let output = ''
  process.stdout.write = ((data: string) => { output += data; return true }) as typeof process.stdout.write
  try { screen.render() } finally { process.stdout.write = original }
  return output
}

test('mount completion keeps required arguments editable before execution', () => {
  const screen = fixture()
  let executed = false
  screen.on('line', () => { executed = true })
  screen.line = '/mount'; screen.cursor = screen.line.length
  screen.key('', { name: 'return' })
  assert.equal(screen.line, '/mount ')
  assert.equal(executed, false)
  screen.dismissedCompletion = ''
  screen.key('', { name: 'tab' })
  assert.equal(screen.line, '/mount plugins')
  screen.insert(' "/path with spaces"')
  assert.deepEqual(screen.suggestions(), [])
  screen.key('', { name: 'return' })
  assert.equal(executed, true)
})

test('header highlights the selected page and healthy modules stay hidden', () => {
  const screen = fixture()
  const output = render(screen)
  assert.ok(output.includes(`me.CLI ${VERSION}`))
  assert.ok(!output.includes('Core b1-Rc1'))
  assert.ok(output.includes('\x1b[1;97m控制台'))
  assert.ok(output.includes('\x1b[90m日志'))
  assert.ok(output.includes('\x1b[90m状态'))
  assert.ok(output.includes('Ctrl+数字键切换'))
  assert.ok(!output.includes('─'))
  assert.ok(!output.includes('●'))
  screen.errors.add('me.cli')
  assert.deepEqual(screen.footer(24).map(clean), ['● me.cli', ''])
  screen.errors.clear()
  screen.snapshot!.plugins[1].state = 'Quarantined'
  assert.ok(screen.footer(24)[0].includes('\x1b[31m●\x1b[0m me.init'))
  screen.snapshot!.plugins[1].state = 'Stopped'
  assert.deepEqual(screen.footer(24), [])
})

test('wheel scrolls only the middle viewport on every page and preserves the input', () => {
  const screen = fixture()
  screen.consoleLines = Array.from({ length: 100 }, (_, i) => 'console ' + i)
  screen.logs = Array.from({ length: 100 }, (_, i) => 'log ' + i)
  screen.stateLines = () => Array.from({ length: 100 }, (_, i) => 'state ' + i)
  screen.line = 'draft'; screen.cursor = 2
  const height = screen.bodyRows()
  screen.wheel(1, 10, 1)
  screen.wheel(1, 10, height + 3)
  assert.equal(screen.consoleScroll, 0)
  const before = render(screen)
  screen.wheel(1, 10, 3)
  const output = render(screen)
  assert.equal(screen.consoleScroll, 3)
  const changedRows = [...output.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]))
  assert.ok(changedRows.length > 0)
  assert.ok(changedRows.every(row => row >= 3 && row <= height + 2))
  assert.ok(before.includes(`me.CLI ${VERSION}`))
  screen.scroll(Infinity)
  assert.equal(screen.consoleScroll, 100 - height)
  screen.scroll(-Infinity)
  assert.equal(screen.consoleScroll, 0)
  screen.setPage('logs'); screen.wheel(1, 10, 3)
  assert.equal(screen.logScroll, 3)
  screen.appendLog('new log')
  assert.equal(screen.logScroll, 4)
  screen.setPage('status'); screen.wheel(-1, 10, 3)
  assert.equal(screen.stateScroll, 3)
  screen.key('', { name: 'end' })
  assert.equal(screen.stateScroll, 100 - height)
  screen.setPage('console'); screen.setPage('status')
  assert.equal(screen.stateScroll, 100 - height)
  assert.equal(screen.line, 'draft'); assert.equal(screen.cursor, 2)
})

test('slash menu filters commands, selects with arrows and completes plugin arguments', () => {
  const screen = fixture()
  const lines: string[] = []
  screen.on('line', line => lines.push(line))
  screen.insert('/re')
  assert.deepEqual(screen.suggestions().map(item => item.value), ['/reload', '/retryCleanup'])
  assert.ok(render(screen).includes('重试失败的资源清理'))
  screen.key('', { name: 'down' })
  screen.key('', { name: 'return' })
  assert.equal(screen.line, '/retryCleanup ')
  assert.deepEqual(lines, [])
  screen.insert('me.i')
  screen.key('', { name: 'tab' })
  assert.equal(screen.line, '/retryCleanup me.init')
  screen.key('', { name: 'return' })
  assert.deepEqual(lines, ['/retryCleanup me.init'])
  screen.insert('/')
  screen.key('', { name: 'escape' })
  assert.deepEqual(screen.menu(), [])
  screen.insert('h')
  assert.deepEqual(screen.suggestions().map(item => item.value), ['/help'])
  screen.key('', { name: 'return' })
  assert.deepEqual(lines, ['/retryCleanup me.init', '/help'])
})

test('drag selection freezes visible text and copies only on Ctrl+C', () => {
  const screen = fixture()
  screen.consoleLines = ['中文 abc', 'second line']
  screen.line = 'draft'; screen.cursor = 2
  const copied: string[] = []
  screen.clipboard.copy = async text => { copied.push(text); return 'confirmed' }
  render(screen)
  screen.mouse(0, 1, 3, false)
  screen.append('arrived during selection')
  screen.mouse(32, 4, 3, false)
  const selected = render(screen)
  assert.ok(selected.includes('\x1b[7m'))
  assert.ok(selected.includes('右键或Ctrl+C复制'))
  screen.mouse(0, 4, 3, true)
  assert.deepEqual(copied, [])
  assert.ok(screen.selection)
  screen.key('', { name: 'c', ctrl: true })
  assert.deepEqual(copied, ['中文'])
  assert.equal(screen.line, 'draft'); assert.equal(screen.cursor, 2)
  screen.key('', { name: 'escape' })
  assert.equal(screen.selection, undefined)
  assert.ok(render(screen).includes('arrived during selection'))
  const logs = screen.logs
  const errors = screen.errors
  screen.clear()
  assert.deepEqual(screen.consoleLines, [])
  assert.equal(screen.page, 'console')
  assert.equal(screen.logs, logs); assert.equal(screen.errors, errors)
  assert.equal(screen.line, 'draft')
})

test('right click confirms copying without changing the draft or reading position', async () => {
  const screen = fixture()
  screen.logs = Array.from({ length: 100 }, (_, i) => '中文 ' + i)
  screen.page = 'logs'; screen.logScroll = 10
  screen.line = 'draft'; screen.cursor = 2
  const copied: string[] = []
  screen.clipboard.copy = async text => { copied.push(text); return 'confirmed' }
  render(screen)
  screen.mouse(0, 1, 3, false)
  screen.mouse(32, 4, 3, false)
  screen.mouse(0, 4, 3, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(screen.selection)
  assert.equal(screen.copyFeedback, '')
  screen.mouse(2, 10, 3, true)
  assert.equal(copied.length, 0)
  screen.mouse(2, 10, 3, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(copied, ['中文'])
  assert.equal(screen.selection, undefined)
  assert.equal(screen.logScroll, 10)
  assert.equal(screen.line, 'draft'); assert.equal(screen.cursor, 2)
  assert.ok(render(screen).includes('已复制'))
  screen.clearSelection()
})

test('unconfirmed and failed right click copies retain the selection for retry', async () => {
  const screen = fixture()
  const failures: unknown[] = []
  screen.on('copyFailed', error => failures.push(error))
  screen.consoleLines = ['selected text']
  render(screen)
  screen.mouse(2, 1, 3, false)
  assert.equal(screen.selection, undefined)
  screen.mouse(0, 1, 3, false); screen.mouse(32, 8, 3, false)
  const selection = screen.selection
  screen.clipboard.copy = async () => 'requested'
  screen.mouse(2, 1, 3, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(screen.selection, selection)
  assert.equal(screen.copyFeedback, '复制请求已发送')
  assert.ok(render(screen).includes('复制请求已发送'))
  screen.clipboard.copy = async () => { throw new Error('write failed') }
  screen.mouse(2, 1, 3, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(screen.selection, selection)
  assert.equal(failures.length, 1)
  let finish!: (status: 'confirmed') => void
  screen.clipboard.copy = () => new Promise(resolve => { finish = resolve })
  screen.mouse(2, 1, 3, false)
  screen.clearSelection()
  screen.mouse(0, 2, 3, false)
  const newer = screen.selection
  finish('confirmed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(screen.selection, newer)
  assert.equal(screen.copyFeedback, '')
  screen.clearSelection()
})

test('debug remains expanded through snapshots and Ctrl+3 restores the normal view', () => {
  const screen = fixture()
  const terminal = new Terminal(true, false, false)
  terminal.screen = screen
  screen.snapshot!.plugins[0].provides = ['cli.info']
  terminal.status(screen.snapshot!, 'me.cli', true)
  assert.ok(screen.debug)
  assert.ok(screen.stateLines().join('\n').includes('提供服务: cli.info'))
  terminal.update(structuredClone(screen.snapshot!))
  assert.ok(screen.debug)
  assert.equal(screen.focus, 'me.cli')
  screen.key('', { name: '3', ctrl: true })
  assert.equal(screen.debug, false)
  assert.equal(screen.focus, undefined)
  assert.ok(!screen.stateLines().join('\n').includes('generation'))
})
