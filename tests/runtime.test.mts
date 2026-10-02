import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { Client, RuntimeError } from '../src/client.mts'
import type { Snapshot } from '../src/protocol.mts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const plugin = (snapshot: Snapshot, id: string) => {
  const result = snapshot.plugins.find(plugin => plugin.id === id)
  assert.ok(result, id)
  return result
}

test('debug is a local view over status and validates module names', async () => {
  const result = await exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'en', '--json', '-c', 'debug', '-c', 'debug me.init', '-c', 'debug core', '-c', 'status'])
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const debug = frames.filter(frame => frame.type === 'debug')
  assert.equal(debug.length, 3)
  assert.equal(debug[1].plugin, 'me.init')
  assert.equal(debug[2].plugin, 'core')
  assert.deepEqual(debug[0].snapshot, debug[1].snapshot)
  assert.ok(frames.some(frame => frame.type === 'status'))
  const focused = await exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'en', '--plain', '-c', 'debug me.init'])
  const details = focused.stdout.slice(focused.stdout.indexOf('\nCore b1-Rc1'))
  assert.ok(details.includes('Provides: me.init.info'))
  assert.ok(!details.includes('Provides: me.cli.info'))
  await assert.rejects(exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'en', '--plain', '-c', 'debug missing']), error => {
    assert.ok(String((error as { stdout: string }).stdout).includes('[FAILED]'))
    return true
  })
})

async function stop(client: Client): Promise<void> {
  if (client.exited) return
  try { await client.request('shutdown').result } catch { client.terminate() }
  await client.closed
}

test('mount commands load TS/Python manifests and persist them for the next launch', { timeout: 200_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'me-cli-mount-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'plugins.json')
  await writeFile(config, JSON.stringify({ plugins: [] }))
  const ts = path.join(directory, 'ts plugin')
  const py = path.join(directory, 'py plugin')
  await mkdir(ts); await mkdir(py)
  await writeFile(path.join(ts, 'plugin.json'), JSON.stringify({ id: 'fixture.ts', command: ['${NODE}', 'plugin.mts'], provides: ['fixture.ts.info'] }))
  await writeFile(path.join(ts, 'plugin.mts'), `import { run } from ${JSON.stringify(path.join(root, 'core/bridge/sdk/typescript/sdk.mts'))}
await run(async ctx => { await ctx.provide('fixture.ts.info', async () => 'ready') })
`)
  await writeFile(path.join(py, 'plugin.json'), JSON.stringify({ id: 'fixture.py', command: ['${PYTHON}', 'plugin.py'], required: ['fixture.ts.info'] }))
  await writeFile(path.join(py, 'plugin.py'), `import sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'core/bridge/sdk/python'))})
from core_bridge import run
async def start(ctx):
    assert await ctx.call('fixture.ts.info', 'info', None) == 'ready'
run(start)
`)
  const result = await exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--config', config, '--language', 'zh', '--json',
    '-c', `/mount plugins "${ts}"`, '-c', `/mount plugins "${path.join(py, 'plugin.json')}"`, '-c', '/reload fixture.ts', '-c', '/status'])
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const status = frames.filter(frame => frame.type === 'status').at(-1).snapshot as Snapshot
  assert.equal(plugin(status, 'fixture.ts').state, 'Running')
  assert.equal(plugin(status, 'fixture.py').state, 'Running')
  assert.ok(frames.some(frame => frame.type === 'log' && frame.message === '已挂载fixture.ts'))
  const saved = JSON.parse(await readFile(config, 'utf8'))
  assert.equal(saved.plugins.length, 2)
  assert.equal(saved.plugins[0].dir, ts)
  assert.ok(saved.plugins.every((item: { autostart: boolean }) => item.autostart))
  const client = new Client('python3', root, config)
  t.after(() => stop(client))
  const ready = await client.ready
  assert.equal(plugin(ready, 'fixture.ts').state, 'Running')
  assert.equal(plugin(ready, 'fixture.py').state, 'Running')
  const before = await readFile(config, 'utf8')
  await assert.rejects(client.request('mount', undefined, ts).result, /already configured/)
  await assert.rejects(client.request('mount', undefined, path.join(directory, 'missing')).result, /no such file/)
  assert.equal(await readFile(config, 'utf8'), before)
})

test('real TS/Python bodies follow dependencies, reload and dispose to baseline', { timeout: 200_000 }, async t => {
  const client = new Client('python3', root)
  t.after(() => stop(client))
  const ready = await client.ready
  assert.equal(plugin(ready, 'me.cli').state, 'Running')
  assert.equal(plugin(ready, 'me.init').state, 'Running')
  assert.deepEqual(plugin(ready, 'me.cli').required, ['me.init.info'])
  assert.deepEqual(plugin(ready, 'me.init').provides, ['me.init.info'])
  const baseline = ready.stats.Resources
  const generation = plugin(ready, 'me.cli').generation
  const stopped = await client.request('stop', 'me.init').result
  assert.equal(plugin(stopped, 'me.cli').state, 'Waiting')
  assert.equal(plugin(stopped, 'me.init').state, 'Stopped')
  assert.equal(stopped.stats.Resources, 0)
  const started = await client.request('start', 'me.init').result
  assert.equal(plugin(started, 'me.cli').state, 'Running')
  assert.ok(plugin(started, 'me.cli').generation > generation)
  for (let i = 0; i < 3; i++) {
    const reloaded = await client.request('reload', 'me.cli').result
    assert.equal(reloaded.stats.Resources, baseline)
    assert.equal(reloaded.stats.Dirty, 0)
  }
  const closed = await client.request('shutdown').result
  assert.equal(closed.state, 'closed')
  assert.equal(closed.stats.Resources, 0)
  assert.equal(await client.closed, 0)
})

test('failed cleanup stays inspectable and explicit retry releases the same generation', { timeout: 200_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'me-cli-cleanup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'resource')
  const fixture = path.join(directory, 'plugin.mts')
  await writeFile(fixture, `import { run } from ${JSON.stringify(path.join(root, 'core/bridge/sdk/typescript/sdk.mts'))}
import { writeFile, rm } from 'node:fs/promises'
await run(async ctx => {
  await writeFile(${JSON.stringify(file)}, String(process.pid))
  let first = true
  await ctx.defer('external resource', async () => {
    if (first) { first = false; throw new Error('cleanup failed once') }
    await rm(${JSON.stringify(file)})
  })
})
`)
  const config = path.join(directory, 'plugins.json')
  await writeFile(config, JSON.stringify({ plugins: [{ id: 'fixture', command: [process.execPath, fixture], autostart: true }] }))
  const client = new Client('python3', root, config)
  t.after(() => stop(client))
  await client.ready
  const pid = Number(await readFile(file, 'utf8'))
  await assert.rejects(client.request('stop', 'fixture').result, error => {
    assert.ok(error instanceof RuntimeError)
    assert.equal(plugin(error.snapshot, 'fixture').state, 'Quarantined')
    assert.ok(plugin(error.snapshot, 'fixture').resources.some(resource => resource.dirty))
    return true
  })
  await assert.rejects(client.request('reload', 'fixture').result, /quarantined/)
  const retried = await client.request('retryCleanup', 'fixture').result
  assert.equal(plugin(retried, 'fixture').state, 'Stopped')
  assert.equal(retried.stats.Resources, 0)
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  await assert.rejects(readFile(file), /ENOENT/)
})

test('a slow start can be cancelled while status remains available', { timeout: 200_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'me-cli-cancel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = path.join(directory, 'plugin.mts')
  await writeFile(fixture, `import { run } from ${JSON.stringify(path.join(root, 'core/bridge/sdk/typescript/sdk.mts'))}
await run(async ctx => {
  await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }))
  throw new Error('initialization cancelled')
})
`)
  const config = path.join(directory, 'plugins.json')
  await writeFile(config, JSON.stringify({ plugins: [{ id: 'slow', command: [process.execPath, fixture], autostart: false }] }))
  const client = new Client('python3', root, config)
  t.after(() => stop(client))
  await client.ready
  const operation = client.request('start', 'slow')
  const failed = assert.rejects(operation.result, /cancel|initialization/i)
  let starting = false
  for (let i = 0; i < 100; i++) {
    const state = await client.request('status').result
    if (plugin(state, 'slow').state === 'Starting') { starting = true; break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(starting)
  client.cancel(operation.id)
  await failed
  let status = await client.request('status').result
  const deadline = Date.now() + 5000
  while (status.stats.Resources && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    status = await client.request('status').result
  }
  assert.equal(status.stats.Resources, 0)
})

test('JSON command mode emits parseable logs and closes Core on exit', { timeout: 200_000 }, async () => {
  const result = await exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'en', '--json', '-c', 'status', '-c', 'reload me.cli'])
  assert.equal(result.stderr, '')
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(frames.some(frame => frame.type === 'ready'))
  assert.ok(frames.some(frame => frame.type === 'status' && frame.snapshot.plugins.length === 2))
  assert.ok(frames.some(frame => frame.type === 'log' && frame.message.includes('all managed resources released')))
  assert.ok(!result.stdout.includes('\x1b'))
})

test('invalid configuration reports the error without leaving a host', { timeout: 200_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'me-cli-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'plugins.json')
  await writeFile(config, '{"plugins":[],"unknown":true}')
  const client = new Client('python3', root, config)
  await assert.rejects(client.ready, /exited/)
  assert.equal(await client.closed, 1)
})

test('clear preserves the runtime and invalid commands report FAILED', { timeout: 200_000 }, async () => {
  const result = await exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'en', '--json', '-c', 'status', '-c', 'clear', '-c', 'status'])
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const states = frames.filter(frame => frame.type === 'status').map(frame => frame.snapshot)
  assert.equal(states.length, 2)
  assert.deepEqual(states[0], states[1])
  assert.ok(frames.some(frame => frame.type === 'clear'))
  for (const command of ['unknown', 'stop', 'stop missing']) {
    await assert.rejects(exec(process.execPath, [path.join(root, 'me.CLI/main.mts'), '--language', 'en', '--json', '-c', command]), (error: unknown) => {
      const output = (error as { stdout: string }).stdout.trim().split('\n').map(line => JSON.parse(line))
      assert.ok(output.some(frame => frame.type === 'log' && frame.source === 'me.cli' && frame.level === 'failed'))
      assert.ok(!output.some(frame => frame.type === 'log' && frame.source === 'me.cli' && frame.level === 'error'))
      return true
    })
  }
})
