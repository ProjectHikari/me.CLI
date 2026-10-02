import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export type CopyStatus = 'confirmed' | 'requested' | 'cancelled'

export function osc52(text: string, tmux = Boolean(process.env.TMUX)): string {
  if (Buffer.byteLength(text) > 100_000) throw new Error('Clipboard selection exceeds 100000 bytes')
  const sequence = '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07'
  return tmux ? '\x1bPtmux;' + sequence.replaceAll('\x1b', '\x1b\x1b') + '\x1b\\' : sequence
}

export class Clipboard {
  child?: ChildProcessWithoutNullStreams
  ready?: Promise<void>
  pending?: { id: number; resolve: () => void; reject: (error: Error) => void }
  queue: Promise<CopyStatus> = Promise.resolve('cancelled')
  next = 0
  closed = false
  write: (sequence: string) => void

  constructor(write: (sequence: string) => void = sequence => { process.stdout.write(sequence) }) { this.write = write }

  async native(text: string, id: number): Promise<void> {
    if (process.platform !== 'linux') throw new Error('Native clipboard unavailable')
    if (!this.ready) this.ready = new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/python3', [fileURLToPath(new URL('./clipboard.py', import.meta.url))], { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
      this.child = child
      let buffer = ''
      const fail = () => { const error = new Error('Native clipboard unavailable'); reject(error); this.pending?.reject(error); this.pending = undefined }
      child.on('error', fail); child.on('exit', fail)
      child.stdin.on('error', fail)
      child.stderr.resume()
      child.stdout.on('data', data => {
        buffer += String(data)
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const frame = JSON.parse(line)
            if (frame.ready) resolve()
            else if (frame.id === this.pending?.id) {
              if (frame.error) this.pending?.reject(new Error(String(frame.error)))
              else this.pending?.resolve()
              this.pending = undefined
            }
          } catch { fail() }
        }
      })
    })
    await this.ready
    if (this.closed || id !== this.next) return
    await new Promise<void>((resolve, reject) => {
      this.pending = { id, resolve, reject }
      this.child!.stdin.write(JSON.stringify({ id, text }) + '\n')
    })
  }

  copy(text: string): Promise<CopyStatus> {
    if (!text || this.closed) return Promise.resolve('cancelled')
    const sequence = osc52(text)
    const id = ++this.next
    const operation = this.queue.catch(() => 'cancelled' as const).then(async (): Promise<CopyStatus> => {
      if (this.closed || id !== this.next) return 'cancelled'
      let timer: ReturnType<typeof setTimeout> | undefined
      let native = false
      try {
        await Promise.race([this.native(text, id), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.child?.kill(); reject(new Error('Clipboard timed out')) }, 1500) })])
        native = true
      } catch {} finally { if (timer) clearTimeout(timer) }
      if (this.closed || id !== this.next) return 'cancelled'
      if (!native || process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.TMUX) {
        this.write(sequence)
        return 'requested'
      }
      return 'confirmed'
    })
    this.queue = operation
    return operation
  }

  cancel(): void { this.next++ }

  close(): void {
    this.closed = true; this.cancel()
    this.child?.stdin.end()
    if (this.child && this.child.exitCode === null) {
      const child = this.child
      const timer = setTimeout(() => child.kill(), 1500)
      child.once('exit', () => clearTimeout(timer))
    }
  }
}
