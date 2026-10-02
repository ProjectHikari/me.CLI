import assert from 'node:assert/strict'
import test from 'node:test'
import { Keyboard } from '../src/keyboard.mts'
import { fit, width } from '../src/display.mts'

test('extended control digits and Ctrl+C survive fragmented terminal input', () => {
  const keys: { name?: string; ctrl?: boolean }[] = []
  const input = new Keyboard((_text, key) => keys.push(key), () => {})
  try {
    for (const chunk of ['\x1b[49;', '5u\x1b[27;5;', '50~\x1b[51;5u', '\x1b[99;5u', '\x03', '\x1b[49;5:3u']) input.feed(Buffer.from(chunk))
    assert.deepEqual(keys.map(key => [key.name, key.ctrl]), [['1', true], ['2', true], ['3', true], ['c', true], ['c', true]])
  } finally { input.close() }
})

test('bracketed paste is text and does not execute pasted keys', () => {
  const keys: string[] = [], paste: string[] = []
  const input = new Keyboard((_text, key) => keys.push(key.name ?? ''), text => paste.push(text))
  try {
    input.feed(Buffer.from('\x1b[200~/reload 中文\x1b[49;5u\x1b[20'))
    input.feed(Buffer.from('1~\r'))
    assert.equal(paste.join(''), '/reload 中文\x1b[49;5u')
    assert.deepEqual(keys, ['return'])
  } finally { input.close() }
})

test('Chinese and ANSI colors stay within the terminal row width', () => {
  const row = fit('\x1b[32m中文abc', 5)
  assert.equal(width(row), 5)
  assert.match(row, /中文a/)
  assert.ok(row.includes('\x1b[32m'))
  assert.equal(width(fit('中文', 3)), 3)
})

test('SGR wheel reports survive fragmentation and mouse clicks do not become input', () => {
  const keys: string[] = [], wheels: number[][] = [], paste: string[] = []
  const input = new Keyboard(text => keys.push(text), text => paste.push(text), (...event) => wheels.push(event))
  try {
    for (const chunk of ['\x1b[<64;', '10;12M\x1b[<65;10;', '12M\x1b[<0;3;4M\x1b[<0;3;4m', '\x1b[<66;10;12M', 'x']) input.feed(Buffer.from(chunk))
    assert.deepEqual(wheels, [[1, 10, 12], [-1, 10, 12]])
    assert.deepEqual(keys, ['x'])
    input.feed(Buffer.from('\x1b[200~\x1b[<64;10;12M\x1b[201~'))
    assert.deepEqual(paste, ['\x1b[<64;10;12M'])
    assert.equal(wheels.length, 2)
  } finally { input.close() }
})

test('SGR selection distinguishes press, drag and release without leaking into commands', () => {
  const mouse: [number, number, number, boolean][] = [], keys: string[] = []
  const input = new Keyboard(text => keys.push(text), () => {}, () => {}, (...event) => mouse.push(event))
  try {
    input.feed(Buffer.from('\x1b[<0;2;3M\x1b[<32;8;'))
    input.feed(Buffer.from('3M\x1b[<0;8;3m\x1b[<2;8;'))
    input.feed(Buffer.from('3M\x1b[<2;8;3m'))
    assert.deepEqual(mouse, [[0, 2, 3, false], [32, 8, 3, false], [0, 8, 3, true], [2, 8, 3, false], [2, 8, 3, true]])
    assert.deepEqual(keys, [])
  } finally { input.close() }
})
