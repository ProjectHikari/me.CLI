import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCommand, complete } from '../src/commands.mts'
import { clean } from '../src/terminal.mts'

test('slash commands validate arguments before calling the host', () => {
  assert.deepEqual(parseCommand('/Reload me.cli'), { method: 'reload', plugin: 'me.cli' })
  assert.deepEqual(parseCommand('/retryCleanup me.init'), { method: 'retryCleanup', plugin: 'me.init' })
  assert.deepEqual(parseCommand('retry-cleanup me.init'), { method: 'retryCleanup', plugin: 'me.init' })
  assert.deepEqual(parseCommand('/plugins'), { method: 'status' })
  assert.deepEqual(parseCommand('/debug'), { method: 'debug' })
  assert.deepEqual(parseCommand('/debug me.init'), { method: 'debug', plugin: 'me.init' })
  assert.deepEqual(parseCommand('/mount plugins /qq'), { method: 'mount', path: '/qq' })
  assert.deepEqual(parseCommand('/mount plugins "./plugins/qq bot"'), { method: 'mount', path: './plugins/qq bot' })
  assert.deepEqual(parseCommand("/Mount plugins './plugins/qq bot'"), { method: 'mount', path: './plugins/qq bot' })
  assert.equal(parseCommand('  '), undefined)
  assert.throws(() => parseCommand('/start'), /Usage/)
  assert.throws(() => parseCommand('/stop me.init extra'), /Usage/)
  assert.throws(() => parseCommand('/help me.init'), /Usage/)
  assert.throws(() => parseCommand('/unknown'), /Unknown/)
  assert.throws(() => parseCommand('/debug me.init extra'), /Usage/)
  for (const line of ['/mount', '/mount plugins', '/mount qq ./qq', '/mount plugins ./qq extra', '/mount plugins ""', '/mount plugins "./qq']) {
    assert.throws(() => parseCommand(line), /Usage/)
  }
})

test('completion distinguishes command names from plugin IDs', () => {
  assert.deepEqual(complete('/re', []), [['/reload', '/retryCleanup'], '/re'])
  assert.deepEqual(complete('/stop me.i', ['me.cli', 'me.init']), [['me.init'], 'me.i'])
  assert.deepEqual(complete('/help me', ['me.init']), [[], '/help me'])
  assert.deepEqual(complete('/debug me.i', ['me.cli', 'me.init']), [['me.init'], 'me.i'])
  assert.deepEqual(complete('/debug co', ['me.init']), [['core'], 'co'])
  assert.deepEqual(complete('/mount pl', ['me.init']), [['plugins'], 'pl'])
  assert.deepEqual(complete('/mount plugins ', ['me.init']), [[], '/mount plugins '])
})

test('plugin output cannot execute terminal control sequences', () => {
  assert.equal(clean('\x1b[2Jhello\x1b]0;bad\x07\r\x00 world'), 'hello world')
  assert.equal(clean('中文\nhello'), '中文\nhello')
})
