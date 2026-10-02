import { stripVTControlCharacters } from 'node:util'
import type { Snapshot } from './protocol.mts'

export const colors: Record<string, string> = { info: '\x1b[38;5;117m', ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', failed: '\x1b[31m' }

export function errorModules(snapshot: Snapshot | undefined, errors: Set<string>): string[] {
  const modules = new Set([...errors].map(source => source === 'core' ? 'Core' : source))
  for (const plugin of snapshot?.plugins ?? []) {
    if (['Failed', 'Quarantined'].includes(plugin.state) || plugin.resources?.some(resource => resource.dirty)) modules.add(plugin.id)
  }
  return [...modules]
}

export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export function cellWidth(char: string): number {
  if (/\p{Mark}/u.test(char)) return 0
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1
}

export function width(text: string): number { return Array.from(clean(text)).reduce((sum, char) => sum + cellWidth(char), 0) }
export function pad(text: string, columns: number): string { return text + ' '.repeat(Math.max(0, columns - width(text))) }

export function fit(text: string, columns: number): string {
  let result = '', used = 0
  for (const token of text.match(/\x1b\[[0-9;]*m|[^]/gu) ?? []) {
    if (token.startsWith('\x1b[')) { result += token; continue }
    const cells = cellWidth(token)
    if (used + cells > columns) break
    result += token
    used += cells
  }
  return result + '\x1b[0m' + ' '.repeat(Math.max(0, columns - used))
}
