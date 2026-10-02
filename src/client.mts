import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Frame, Log, Snapshot } from './protocol.mts'
import { t, type Language } from './i18n.mts'

type Pending = { resolve: (snapshot: Snapshot) => void; reject: (error: Error) => void }

export class RuntimeError extends Error {
  snapshot: Snapshot
  constructor(message: string, snapshot: Snapshot) { super(message); this.snapshot = snapshot }
}

export class Client extends EventEmitter {
  child: ChildProcessWithoutNullStreams
  snapshot?: Snapshot
  pending = new Map<string, Pending>()
  next = 0
  ready: Promise<Snapshot>
  closed: Promise<number>
  exited = false
  #buffer = Buffer.alloc(0)
  #readyResolve!: (snapshot: Snapshot) => void
  #readyReject!: (error: Error) => void
  #settled = false

  constructor(python: string, root: string, config?: string, language: Language = 'en') {
    super()
    this.ready = new Promise((resolve, reject) => { this.#readyResolve = resolve; this.#readyReject = reject })
    this.child = spawn(python, [`${root}/me.init/main.py`, '--protocol', '--language', language, '--root', root, ...(config ? ['--config', config] : [])], {
      stdio: 'pipe', detached: process.platform !== 'win32',
      env: { ...process.env, ME_LANGUAGE: language, ME_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
    })
    const startup = setTimeout(() => this.fail(new Error(t(language, 'Runtime initialization timed out'))), 200_000)
    this.closed = new Promise(resolve => {
      this.child.once('error', error => this.fail(error))
      this.child.once('close', (code, signal) => {
        clearTimeout(startup)
        this.exited = true
        const error = new Error(t(language, 'Runtime host exited ({code})', { code: signal ?? code ?? 1 }))
        if (!this.#settled) this.#readyReject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.emit('closed', code ?? 1)
        resolve(code ?? 1)
      })
    })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stdout.on('data', (data: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, data])
      try {
        for (;;) {
          const end = this.#buffer.indexOf(10)
          if (end < 0) break
          if (end > 1 << 20) throw new Error(t(language, 'Host frame exceeds 1 MiB'))
          const frame = JSON.parse(this.#buffer.subarray(0, end).toString('utf8')) as Frame
          this.#buffer = this.#buffer.subarray(end + 1)
          if (frame.type === 'log') {
            if (typeof frame.message !== 'string' || typeof frame.source !== 'string') throw new Error(t(language, 'Invalid log frame'))
            this.emit('log', frame)
            continue
          }
          if (!['ready', 'state', 'response'].includes(frame.type) || !frame.snapshot || !Array.isArray(frame.snapshot.plugins)) {
            throw new Error(t(language, 'Invalid host frame'))
          }
          this.snapshot = frame.snapshot
          this.emit('state', this.snapshot)
          if (frame.type === 'ready') {
            clearTimeout(startup)
            this.#settled = true
            this.#readyResolve(frame.snapshot)
          } else if (frame.type === 'response') {
            const pending = this.pending.get(frame.id)
            if (pending) {
              this.pending.delete(frame.id)
              frame.error ? pending.reject(new RuntimeError(frame.error, frame.snapshot)) : pending.resolve(frame.snapshot)
            }
          }
        }
        if (this.#buffer.length > 1 << 20) throw new Error(t(language, 'Host frame exceeds 1 MiB'))
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
    this.child.stderr.on('data', data => this.emit('log', {
      type: 'log', time: new Date().toISOString(), level: 'error', source: 'me.init', message: String(data).trimEnd(),
    } satisfies Log))
  }

  fail(error: Error): void {
    if (!this.#settled) { this.#settled = true; this.#readyReject(error) }
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.terminate()
  }

  request(method: string, plugin?: string, path?: string): { id: string; result: Promise<Snapshot> } {
    const id = `ui${++this.next}`
    const result = new Promise<Snapshot>((resolve, reject) => {
      if (this.exited || this.child.stdin.destroyed) { reject(new Error('Runtime is closed')); return }
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ id, method, ...(plugin ? { plugin } : {}), ...(path ? { path } : {}) }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(error) }
      })
    })
    return { id, result }
  }

  cancel(id: string): void {
    if (this.exited || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify({ id: `cancel${++this.next}`, method: 'cancel', target: id }) + '\n')
  }

  terminate(): void { if (!this.exited) this.child.kill('SIGTERM') }
}
