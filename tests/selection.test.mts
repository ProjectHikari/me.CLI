import assert from 'node:assert/strict'
import test from 'node:test'
import { Selection } from '../src/selection.mts'
import { Clipboard, osc52 } from '../src/clipboard.mts'
import { clean } from '../src/display.mts'

test('selection copies Unicode cell ranges without ANSI or terminal padding', () => {
  const frame = ['\x1b[32m中文abc\x1b[0m     ', '  second row     ']
  const selection = new Selection(frame, 2, 1, 20)
  selection.move(4, 1)
  assert.equal(selection.text(), '中文')
  assert.ok(selection.highlight(frame[0], 0).includes('\x1b[7m'))
  assert.equal(clean(selection.highlight(frame[0], 0)), clean(frame[0]))
  selection.move(8, 2)
  assert.equal(selection.text(), '中文abc\n  second')
  const reversed = new Selection(frame, 8, 2, 20)
  reversed.move(2, 1)
  assert.equal(reversed.text(), selection.text())
  const click = new Selection(frame, 1, 1, 20)
  assert.equal(click.text(), '')
})

test('OSC 52 encodes UTF-8, supports tmux and limits the payload', () => {
  assert.equal(osc52('中文', false), '\x1b]52;c;' + Buffer.from('中文').toString('base64') + '\x07')
  assert.equal(osc52('a', true), '\x1bPtmux;\x1b\x1b]52;c;YQ==\x07\x1b\\')
  assert.throws(() => osc52('x'.repeat(100001)), /exceeds/)
})

test('clipboard fallback keeps only the newest copy and drops cancelled requests', async () => {
  const output: string[] = []
  const clipboard = new Clipboard(value => output.push(value))
  clipboard.native = async () => { throw new Error('no native clipboard') }
  assert.deepEqual(await Promise.all([clipboard.copy('old'), clipboard.copy('new')]), ['cancelled', 'requested'])
  assert.deepEqual(output, [osc52('new')])
  const copy = clipboard.copy('cancelled')
  clipboard.cancel()
  assert.equal(await copy, 'cancelled')
  assert.equal(output.length, 1)
  clipboard.close()
  assert.equal(await clipboard.copy('closed'), 'cancelled')
  assert.equal(output.length, 1)
})

test('closing while a backend is pending prevents late terminal writes', async () => {
  const output: string[] = []
  const clipboard = new Clipboard(value => output.push(value))
  let release!: () => void
  clipboard.native = () => new Promise((_resolve, reject) => { release = () => reject(new Error('unavailable')) })
  const copy = clipboard.copy('selection')
  await new Promise(resolve => setImmediate(resolve))
  clipboard.close()
  release()
  await copy
  assert.deepEqual(output, [])
})

test('only a local native write confirms clipboard delivery', async () => {
  const keys = ['SSH_CONNECTION', 'SSH_TTY', 'TMUX']
  const saved = keys.map(key => process.env[key])
  const output: string[] = []
  const clipboard = new Clipboard(value => output.push(value))
  clipboard.native = async () => {}
  try {
    for (const key of keys) delete process.env[key]
    assert.equal(await clipboard.copy('local'), 'confirmed')
    assert.deepEqual(output, [])
    process.env.SSH_TTY = '/dev/pts/1'
    assert.equal(await clipboard.copy('remote'), 'requested')
    assert.deepEqual(output, [osc52('remote', false)])
  } finally {
    clipboard.close()
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  }
})
