import { open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { clean } from './display.mts'
import type { Log } from './protocol.mts'

export const logLevels = ['FAILED', 'ERROR', 'WARN', 'INFO', 'OK'] as const

export class LogBuffer {
  entries: Log[] = []

  append(event: Log): void {
    const level = logLevels.includes(event.level.toUpperCase() as typeof logLevels[number]) ? event.level.toLowerCase() : 'info'
    for (const message of clean(event.message).split('\n')) this.entries.push({ type: 'log', time: event.time, source: clean(event.source), level, message })
    if (this.entries.length > 1000) this.entries.splice(0, this.entries.length - 1000)
  }

  select(levels: string[] = []): Log[] { return this.entries.filter(entry => !levels.length || levels.includes(entry.level.toUpperCase())) }

  async export(file: string): Promise<{ path: string; count: number }> {
    const target = path.resolve(file), entries = this.entries.slice()
    const handle = await open(target, 'wx', 0o600)
    try {
      const text = entries.map(entry => `[${entry.level.toUpperCase()}] ${clean(entry.time)}  ${entry.source.padEnd(12)} ${entry.message}`).join('\n')
      await handle.writeFile(text + (entries.length ? '\n' : ''), 'utf8')
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(target).catch(() => {})
      throw error
    }
    await handle.close()
    return { path: target, count: entries.length }
  }
}
