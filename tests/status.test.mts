import assert from 'node:assert/strict'
import test from 'node:test'
import { statusLines } from '../src/status.mts'
import { Terminal } from '../src/terminal.mts'
import type { Snapshot } from '../src/protocol.mts'

const snapshot = (): Snapshot => ({ version: 'b1-Rc1', state: 'running', stats: {}, plugins: [
  { id: 'provider', state: 'Running', enabled: true, generation: 1, missing: [], provides: ['info'], resources: [
    { label: 'service: info', kind: 'service', dirty: false },
    { label: 'reader', kind: 'task', dirty: false },
    { label: 'failed disposer', kind: 'disposer', dirty: true, error: 'retry required' },
  ] },
  { id: 'consumer', state: 'Waiting', enabled: true, generation: 0, missing: ['info'], required: ['info'], optional: ['other'], resources: [] },
] })

test('debug lists service contracts, ownership, tasks and cleanup errors', () => {
  const data = snapshot()
  const text = statusLines(data, 'en', text => text, undefined, { debug: true }).join('\n')
  assert.ok(text.includes('Provides: info'))
  assert.ok(text.includes('Required: info'))
  assert.ok(text.includes('Optional: other'))
  assert.ok(text.includes('Required by: consumer'))
  assert.ok(text.includes('provider - task - reader'))
  assert.ok(text.includes('failed disposer - [dirty] - retry required'))
  assert.ok(text.includes('Timers 0\n  None'))
  assert.ok(text.includes('Dirty 1'))
  const focused = statusLines(data, 'zh', text => text, 'consumer', { debug: true }).join('\n')
  assert.ok(focused.includes('必需依赖: info'))
  assert.ok(!focused.includes('reader'))
})

test('normal status hides internals and expands only faults and missing dependencies', () => {
  const data = snapshot()
  data.plugins[0].resources.pop()
  let text = statusLines(data, 'en', text => text).join('\n')
  assert.ok(text.includes('provider - Running'))
  assert.ok(text.includes('consumer - Waiting'))
  assert.ok(text.includes('missing: info'))
  for (const hidden of ['generation', 'Enabled', 'reader', 'Provides:', 'Optional:', 'Timers', 'Listeners', 'Resources']) assert.ok(!text.includes(hidden), hidden)
  data.plugins[0].state = 'Quarantined'
  data.plugins[0].error = 'startup failed\nstack trace'
  data.plugins[0].resources.push({ label: 'stuck cleanup', kind: 'disposer', dirty: true, error: 'cannot release' })
  text = statusLines(data, 'zh', text => text).join('\n')
  assert.ok(text.includes('隔离中'))
  assert.ok(text.includes('startup failed'))
  assert.ok(text.includes('stuck cleanup'))
  assert.ok(text.includes('cannot release'))
  assert.ok(!text.includes('stack trace'))
  assert.ok(!text.includes('reader'))
})

test('ERROR logs expand a running module and recovery collapses it', () => {
  const terminal = new Terminal(true, false, false)
  let output = ''
  terminal.write = text => { output += text }
  const data = snapshot()
  data.plugins[0].resources.pop()
  terminal.update(data)
  terminal.log({ type: 'log', source: 'provider', level: 'error', time: new Date().toISOString(), message: 'connection failed\nstack' })
  output = ''
  terminal.status(data)
  assert.ok(output.includes('provider - Running - [ERROR]'))
  assert.ok(output.includes('connection failed'))
  assert.ok(!output.includes('stack'))
  terminal.log({ type: 'log', source: 'provider', level: 'ok', time: new Date().toISOString(), message: 'recovered' })
  output = ''
  terminal.status(data)
  assert.ok(!output.includes('connection failed'))
  assert.ok(!output.includes('[ERROR]'))
  terminal.errorMessages.set('provider', 'stale error')
  terminal.errors.add('provider')
  const next = structuredClone(data); next.plugins[0].generation++
  terminal.update(next)
  assert.ok(!terminal.errorMessages.has('provider'))
})

test('core debug shows runtime counters without plugin details', () => {
  const data = snapshot()
  data.stats = { Plugins: 2, Services: 1, Resources: 3, Dirty: 1 }
  const text = statusLines(data, 'zh', text => text, 'core', { debug: true }).join('\n')
  assert.ok(text.includes('Core b1-Rc1'))
  assert.ok(text.includes('资源: 3'))
  assert.ok(!text.includes('provider'))
})

test('ERROR persists through ordinary snapshots and clears on OK or recovered generation', () => {
  const terminal = new Terminal(true, false, false)
  terminal.write = () => {}
  const data = snapshot()
  data.plugins[0].resources.pop()
  terminal.update(data)
  terminal.log({ type: 'log', source: 'provider', level: 'error', time: new Date().toISOString(), message: 'failed' })
  terminal.update(structuredClone(data))
  assert.ok(terminal.errors.has('provider'))
  terminal.log({ type: 'log', source: 'provider', level: 'ok', time: new Date().toISOString(), message: 'recovered' })
  assert.ok(!terminal.errors.has('provider'))
  terminal.errors.add('provider')
  const next = structuredClone(data); next.plugins[0].generation++
  terminal.update(next)
  assert.ok(!terminal.errors.has('provider'))
  terminal.help()
  let output = ''
  terminal.write = text => { output += text }
  terminal.help()
  assert.ok(!output.includes('Ctrl+1 console'))
})

test('FAILED is visible command feedback without a module error indicator', () => {
  const terminal = new Terminal(true, false, false)
  const output: string[] = []
  terminal.write = line => { output.push(line) }
  terminal.log({ type: 'log', source: 'me.cli', level: 'failed', time: new Date().toISOString(), message: 'unknown command' })
  assert.ok(output[0].includes('[FAILED]'))
  assert.equal(terminal.errors.size, 0)
  terminal.log({ type: 'log', source: 'me.init', level: 'error', time: new Date().toISOString(), message: 'internal failure' })
  assert.ok(output[1].includes('[ERROR]'))
  assert.ok(terminal.errors.has('me.init'))
})
