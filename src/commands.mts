import { t, type Language } from './i18n.mts'

export const VERSION = 'b1-Rc9'
export const commands = [
  { name: 'status', args: '[plugin]', description: 'Show Core and plugin state' },
  { name: 'debug', args: '[module]', description: 'Show all state details; add a module name to inspect it' },
  { name: 'plugins', args: '', description: 'List registered plugins' },
  { name: 'mount', args: 'plugins <path>', description: 'Mount and save a plugin' },
  { name: 'console', args: '', description: 'Open the console page' },
  { name: 'logs', args: '', description: 'Open the live log page' },
  { name: 'clear', args: '', description: 'Clear console output' },
  { name: 'start', args: '<plugin>', description: 'Start a plugin' },
  { name: 'stop', args: '<plugin>', description: 'Stop a plugin and its dependents' },
  { name: 'reload', args: '<plugin>', description: 'Dispose and create a fresh generation' },
  { name: 'retryCleanup', args: '<plugin>', description: 'Retry failed resource cleanup' },
  { name: 'help', args: '', description: 'Show commands and shortcuts' },
  { name: 'quit', args: '', description: 'Close Core and exit' },
]

export type Command = { method: string; plugin?: string; path?: string }
export class CommandError extends Error {}

export function parseCommand(line: string, language: Language = 'en'): Command | undefined {
  const parts = line.trim().replace(/^\//, '').split(/\s+/)
  if (!parts[0]) return undefined
  let name = parts[0].toLowerCase()
  if (name === 'retry-cleanup') name = 'retrycleanup'
  if (name === 'exit') name = 'quit'
  const spec = commands.find(command => command.name.toLowerCase() === name)
  if (!spec) throw new CommandError(t(language, 'Unknown command /{name}. Use /help', { name }))
  name = spec.name
  const usage = t(language, 'Usage: {usage}', { usage: `/${name} ${t(language, spec.args)}`.trim() })
  if (name === 'mount') {
    const match = line.trim().match(/^\/?mount\s+plugins\s+(.+)$/i)
    if (!match) throw new CommandError(usage)
    let path = match[1].trim()
    if (path.startsWith('"') || path.startsWith("'")) {
      if (path.length < 3 || path.at(-1) !== path[0] || path.slice(1, -1).includes(path[0])) throw new CommandError(usage)
      path = path.slice(1, -1)
    } else if (/\s|["']/.test(path)) throw new CommandError(usage)
    if (!path.trim()) throw new CommandError(usage)
    return { method: 'mount', path }
  }
  if (parts.length > 2 || (!spec.args && parts.length > 1)) throw new CommandError(usage)
  if (spec.args.startsWith('<') && !parts[1]) throw new CommandError(usage)
  return { method: name === 'plugins' ? 'status' : name === 'quit' ? 'shutdown' : name, ...(parts[1] ? { plugin: parts[1] } : {}) }
}

export function complete(line: string, plugins: string[]): [string[], string] {
  const slash = line.startsWith('/') ? '/' : ''
  const mount = line.match(/^\/?mount\s+(\S*)$/i)
  if (mount) return [['plugins'].filter(value => value.startsWith(mount[1])), mount[1]]
  const match = line.match(/^(\/?\S+)\s+(\S*)$/)
  if (match) {
    const spec = commands.find(command => command.name === match[1].replace(/^\//, ''))
    if (!spec?.args || spec.name === 'mount') return [[], line]
    return [(spec.name === 'debug' ? [...plugins, 'core'] : plugins).filter(id => id.startsWith(match[2])), match[2]]
  }
  const choices = commands.map(command => slash + command.name)
  return [choices.filter(command => command.startsWith(line)), line]
}
