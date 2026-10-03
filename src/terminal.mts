import readline from 'node:readline'
import { commands, complete, VERSION } from './commands.mts'
import type { Log, Snapshot } from './protocol.mts'
import { t, type Language } from './i18n.mts'
import { clean, colors, pad, errorModules } from './display.mts'
import { Screen, type Page } from './screen.mts'
import { statusLines } from './status.mts'
import { LogBuffer } from './logs.mts'
export { clean } from './display.mts'

export class Terminal {
  interactive: boolean
  color: boolean
  json: boolean
  rl?: readline.Interface | Screen
  screen?: Screen
  fixed: boolean
  logs: string[] = []
  logBuffer = new LogBuffer()
  logFilter: string[] = []
  currentPage: Page = 'console'
  errors = new Set<string>()
  errorMessages = new Map<string, string>()
  root = ''
  snapshot?: Snapshot
  plugins: string[] = []
  prompting = false
  language: Language

  constructor(plain: boolean, json: boolean, interactive: boolean, language: Language = 'en', inline = false) {
    this.language = language
    this.interactive = interactive
    this.fixed = interactive && !inline && process.env.TERM !== 'dumb'
    this.json = json
    this.color = !plain && !json && Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb'
  }

  style(text: string, escape = '\x1b[90m'): string { return this.color ? escape + text + '\x1b[0m' : text }
  text(template: string, params: Record<string, string | number> = {}): string { return t(this.language, template, params) }

  createScreen(root: string): Screen {
    const screen = new Screen(this.language, this.color, root, VERSION, this.logs, this.errors, this.errorMessages)
    screen.logFilter = this.logFilter.slice()
    screen.on('copyFailed', error => this.log({ type: 'log', time: new Date().toISOString(), level: 'failed', source: 'me.cli', message: this.text('Copy failed: {error}', { error: String(error) }) }))
    return screen
  }

  write(text: string): void {
    if (this.screen && !this.screen.closed) { this.screen.append(text); return }
    if (this.prompting && this.rl && process.stdout.isTTY) {
      const position = this.rl.getCursorPos()
      if (position.rows) readline.moveCursor(process.stdout, 0, -position.rows)
      readline.cursorTo(process.stdout, 0)
      readline.clearScreenDown(process.stdout)
      process.stdout.write(text + '\n')
      this.rl.prompt(true)
    } else process.stdout.write(text + '\n')
  }

  banner(root: string): void {
    if (this.json) return
    this.root = root
    if (this.fixed) { this.screen = this.createScreen(root); return }
    this.write(`\n  ${this.style('me.CLI', '\x1b[1m')}  ${this.style(VERSION)}\n  ${this.style(clean(root))}\n`)
  }

  log(event: Log): void {
    this.logBuffer.append(event)
    const visible = this.currentPage !== 'logs' || !this.logFilter.length || this.logFilter.includes(event.level.toUpperCase())
    if (this.json) { if (visible) this.write(JSON.stringify(event)); return }
    const level = event.level.toLowerCase()
    const tag = ['info', 'ok', 'warn', 'error', 'failed'].includes(level) ? level : 'info'
    const timestamp = Number.isNaN(Date.parse(event.time)) ? '' : new Date(event.time).toLocaleTimeString('en-GB')
    const source = clean(event.source)
    if (tag === 'error') { this.errors.add(source); this.errorMessages.set(source, clean(event.message)) }
    else if (tag === 'ok') { this.errors.delete(source); this.errorMessages.delete(source) }
    for (const line of clean(event.message).split('\n')) {
      const formatted = `  ${this.style(`[${tag.toUpperCase()}]`.padEnd(8), colors[tag])} ${this.style(timestamp, '\x1b[97m')}  ${this.style(source.padEnd(12), '\x1b[97m')} ${this.style(line)}`
      this.logs.push(formatted)
      if (this.logs.length > 1000) this.logs.shift()
      if (this.screen && !this.screen.closed) {
        this.screen.appendLog(formatted)
        if (!this.screen.ready || source === 'me.cli' && ['warn', 'error', 'failed'].includes(tag)) this.screen.append(formatted)
      } else if (visible) this.write(formatted)
    }
  }

  status(snapshot: Snapshot, id?: string, debug = false): void {
    this.update(snapshot)
    if (this.json) { this.write(JSON.stringify({ type: debug ? 'debug' : 'status', snapshot, ...(debug && id ? { plugin: id } : {}) })); return }
    if (this.screen && !this.screen.closed) {
      this.screen.stateScroll = 0
      this.screen.debug = debug
      this.screen.setSnapshot(snapshot, id)
      return
    }
    this.write('\n' + statusLines(snapshot, this.language, (text, color) => this.style(text, color), id, { debug, errors: this.errors, messages: this.errorMessages }).join('\n') + '\n')
  }

  operation(snapshot: Snapshot, id?: string): void {
    if (this.json) { this.status(snapshot, id); return }
    this.update(snapshot)
    if (this.screen && !this.screen.closed) return
    const modules = errorModules(snapshot, this.errors)
    if (modules.length) this.write('  ' + modules.map(name => this.style('●', colors.error) + ' ' + clean(name)).join('  '))
  }

  help(): void {
    this.currentPage = 'console'
    const localized = commands.map(command => ({ ...command, args: this.text(command.args), description: this.text(command.description) }))
    if (this.json) { this.write(JSON.stringify({ type: 'help', commands: localized })); return }
    const lines = localized.map(command => `  ${this.style(pad('/' + command.name + ' ' + command.args, 28), '\x1b[97m')}${command.description}`)
    lines.push('', '  ' + this.style(this.text('Esc cancel operation - Ctrl+C clear/cancel - PgUp/PgDn output history')))
    if (this.screen && !this.screen.closed) {
      this.screen.setPage('console'); this.screen.consoleScroll = 0
    }
    this.write('\n' + lines.join('\n') + '\n')
  }

  clear(): void {
    this.currentPage = 'console'
    if (this.json) { this.write(JSON.stringify({ type: 'clear', page: 'console' })); return }
    if (this.screen && !this.screen.closed) { this.screen.clear(); return }
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
  }

  update(snapshot: Snapshot): void {
    for (const previous of this.snapshot?.plugins ?? []) {
      const current = snapshot.plugins.find(plugin => plugin.id === previous.id)
      if (!current || !['Failed', 'Quarantined'].includes(current.state) && !current.resources.some(resource => resource.dirty) &&
        (['Failed', 'Quarantined'].includes(previous.state) || current.state === 'Running' && current.generation !== previous.generation)) this.errors.delete(previous.id)
    }
    if (snapshot.state === 'closed') this.errors.delete('core')
    for (const source of this.errorMessages.keys()) if (!this.errors.has(source)) this.errorMessages.delete(source)
    this.snapshot = snapshot
    this.plugins = snapshot.plugins.map(plugin => plugin.id)
    if (this.screen && !this.screen.closed) this.screen.setSnapshot(snapshot, this.screen.focus)
  }

  page(page: Page): void {
    this.currentPage = page
    if (this.screen && !this.screen.closed) this.screen.setPage(page)
    else if (page === 'logs') this.showLogs(this.logFilter)
  }

  showLogs(levels: string[] = []): void {
    this.currentPage = 'logs'
    this.logFilter = levels.slice()
    if (this.json) { this.write(JSON.stringify({ type: 'logs', levels, logs: this.logBuffer.select(levels) })); return }
    if (this.screen && !this.screen.closed) { this.screen.filterLogs(levels); return }
    this.write(this.logs.filter(line => !levels.length || levels.includes(clean(line).trimStart().match(/^\[([A-Z]+)\]/)?.[1] ?? '')).join('\n'))
  }

  openInput(): readline.Interface | Screen {
    if (this.fixed) {
      if (!this.screen || this.screen.closed) this.screen = this.createScreen(this.root)
      if (this.snapshot) this.screen.setSnapshot(this.snapshot)
      const input = this.screen
      input.ready = true
      this.rl = input
      input.once('close', () => { if (this.rl === input) { this.prompting = false; this.rl = undefined } })
      return input
    }
    const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: this.interactive,
      prompt: this.style('› ', '\x1b[96m'), historySize: 200, removeHistoryDuplicates: true,
      completer: (line: string) => complete(line, this.plugins), escapeCodeTimeout: 50 })
    this.rl = input
    input.once('close', () => {
      if (this.rl === input) { this.prompting = false; this.rl = undefined }
    })
    return input
  }

  prompt(): void { if (this.interactive && this.rl) { this.prompting = true; this.rl.prompt(true) } }
  close(): void { this.prompting = false; const input = this.rl ?? this.screen; this.rl = undefined; input?.close() }
}
