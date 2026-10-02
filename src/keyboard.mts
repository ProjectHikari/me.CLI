import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import readline from 'node:readline'

// readline不识别CSI-u和modifyOtherKeys，先拆出扩展按键再交给普通输入处理
export class Keyboard {
  input = new PassThrough()
  decoder = new StringDecoder('utf8')
  buffer = ''
  paste = false
  timer?: ReturnType<typeof setTimeout>
  onKey: (text: string, key: readline.Key) => void
  onPaste: (text: string) => void
  onWheel?: (direction: number, x: number, y: number) => void
  onMouse?: (button: number, x: number, y: number, release: boolean) => void

  constructor(onKey: (text: string, key: readline.Key) => void, onPaste: (text: string) => void, onWheel?: (direction: number, x: number, y: number) => void, onMouse?: (button: number, x: number, y: number, release: boolean) => void) {
    this.onKey = onKey; this.onPaste = onPaste; this.onWheel = onWheel; this.onMouse = onMouse
    readline.emitKeypressEvents(this.input)
    this.input.on('keypress', onKey)
  }

  feed(data: Buffer): void {
    if (this.timer) clearTimeout(this.timer)
    this.buffer += this.decoder.write(data)
    while (this.buffer) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~')
        if (end < 0) {
          const keep = this.buffer.lastIndexOf('\x1b')
          const length = keep >= 0 && '\x1b[201~'.startsWith(this.buffer.slice(keep)) ? keep : this.buffer.length
          this.onPaste(this.buffer.slice(0, length)); this.buffer = this.buffer.slice(length)
          break
        }
        this.onPaste(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 6); this.paste = false
        continue
      }
      const escape = this.buffer.indexOf('\x1b')
      if (escape !== 0) {
        const end = escape < 0 ? this.buffer.length : escape
        this.input.write(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end)
        continue
      }
      if (this.buffer.startsWith('\x1b[200~')) { this.paste = true; this.buffer = this.buffer.slice(6); continue }
      const mouse = this.buffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
      if (mouse) {
        const button = Number(mouse[1])
        const x = Number(mouse[2]), y = Number(mouse[3])
        if (mouse[4] === 'M' && x > 0 && y > 0 && (button & 0xc3) === 64) this.onWheel?.(1, x, y)
        if (mouse[4] === 'M' && x > 0 && y > 0 && (button & 0xc3) === 65) this.onWheel?.(-1, x, y)
        if (x > 0 && y > 0 && !(button & 64)) this.onMouse?.(button, x, y, mouse[4] === 'm')
        this.buffer = this.buffer.slice(mouse[0].length)
        continue
      }
      const csi = this.buffer.match(/^\x1b\[([0-9:;]*)([~u])/)
      if (csi) {
        const kitty = csi[2] === 'u' ? csi[1].match(/^(\d+)(?::[\d:]*)?;(\d+)(?::([123]))?(?:;[\d;:]*)?$/) : undefined
        const xterm = csi[2] === '~' ? csi[1].match(/^27;(\d+);(\d+)$/) : undefined
        if (kitty || xterm) {
          const code = Number(kitty?.[1] ?? xterm?.[2])
          const modifiers = Number(kitty?.[2] ?? xterm?.[1]) - 1
          if (kitty?.[3] !== '3' && code > 0 && code <= 0x10ffff) {
            const char = String.fromCodePoint(code)
            const name = ({ 9: 'tab', 13: 'return', 27: 'escape', 127: 'backspace' } as Record<number, string>)[code] ?? char.toLowerCase()
            this.onKey(char, { name, ctrl: Boolean(modifiers & 4), meta: Boolean(modifiers & 2), shift: Boolean(modifiers & 1), sequence: csi[0] })
          }
        } else this.input.write(csi[0])
        this.buffer = this.buffer.slice(csi[0].length)
        continue
      }
      if (/^\x1b(?:\[<?[0-9:;]*)?$/.test(this.buffer) && this.buffer.length < 64) break
      this.input.write('\x1b'); this.buffer = this.buffer.slice(1)
    }
    if (this.buffer && !this.paste) this.timer = setTimeout(() => {
      if (this.buffer === '\x1b') this.onKey('', { name: 'escape', sequence: this.buffer })
      else if (!this.buffer.startsWith('\x1b[<')) this.input.write(this.buffer)
      this.buffer = ''; this.timer = undefined
    }, 50)
  }

  close(): void { if (this.timer) clearTimeout(this.timer); this.input.destroy() }
}
