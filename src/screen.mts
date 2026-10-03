import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { commands, complete } from './commands.mts'
import { clean, colors, fit, width, errorModules } from './display.mts'
import { t, type Language } from './i18n.mts'
import type { Snapshot } from './protocol.mts'
import { Keyboard } from './keyboard.mts'
import { statusLines } from './status.mts'
import { Selection } from './selection.mts'
import { Clipboard } from './clipboard.mts'

export type Page = 'console' | 'logs' | 'status'
const limit = 1000

export class Screen extends EventEmitter {
  language: Language
  color: boolean
  root: string
  version: string
  page: Page = 'console'
  snapshot?: Snapshot
  focus?: string
  debug = false
  line = ''
  cursor = 0
  history: string[] = []
  historyIndex = -1
  draft = ''
  completionIndex = 0
  completionQuery = ''
  dismissedCompletion = ''
  consoleLines: string[] = []
  logs: string[] = []
  logFilter: string[] = []
  errors: Set<string>
  errorMessages: Map<string, string>
  logScroll = 0
  consoleScroll = 0
  stateScroll = 0
  ready = false
  closed = false
  timer?: ReturnType<typeof setTimeout>
  previous: string[] = []
  previousCursor = ''
  frame: string[] = []
  selection?: Selection
  copyRequest = 0
  copyFeedback = ''
  copyFeedbackColor = colors.ok
  copyTimer?: ReturnType<typeof setTimeout>
  clipboard: Clipboard
  wasRaw: boolean
  keyboard: Keyboard
  dataListener: (data: Buffer) => void
  resizeListener: () => void

  constructor(language: Language, color: boolean, root: string, version: string, logs: string[], errors = new Set<string>(), errorMessages = new Map<string, string>()) {
    super()
    this.language = language; this.color = color; this.root = root; this.version = version
    this.logs = logs.slice(-limit)
    this.errors = errors
    this.errorMessages = errorMessages
    this.clipboard = new Clipboard()
    this.wasRaw = Boolean(process.stdin.isRaw)
    this.keyboard = new Keyboard((text, key) => this.key(text, key), text => this.insert(text), (direction, x, y) => this.wheel(direction, x, y), (...event) => this.mouse(...event))
    this.dataListener = data => this.keyboard.feed(data)
    this.resizeListener = () => { this.clearSelection(); this.previous = []; this.schedule() }
    process.stdin.setRawMode(true)
    process.stdin.on('data', this.dataListener)
    process.stdout.on('resize', this.resizeListener)
    process.stdin.resume()
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[>1u\x1b[>4;2m\x1b[2J\x1b[H')
    this.render()
  }

  text(template: string, params: Record<string, string | number> = {}): string { return t(this.language, template, params) }
  style(text: string, escape = '\x1b[90m'): string { return this.color ? escape + text + '\x1b[0m' : text }
  schedule(): void { if (!this.closed && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.render() }, 20) }

  append(text: string): void {
    const lines = text.split('\n')
    this.consoleLines.push(...lines)
    if (this.consoleScroll) this.consoleScroll += lines.length
    if (this.consoleLines.length > limit) this.consoleLines.splice(0, this.consoleLines.length - limit)
    this.consoleScroll = Math.min(this.consoleScroll, this.consoleLines.length)
    this.schedule()
  }

  appendLog(line: string): void {
    this.logs.push(line)
    if (this.logScroll && this.matchesLog(line)) this.logScroll++
    if (this.logs.length > limit) this.logs.shift()
    this.logScroll = Math.min(this.logScroll, this.visibleLogs().length)
    this.schedule()
  }

  matchesLog(line: string): boolean { return !this.logFilter?.length || this.logFilter.includes(clean(line).trimStart().match(/^\[([A-Z]+)\]/)?.[1] ?? '') }
  visibleLogs(): string[] { return this.logs.filter(line => this.matchesLog(line)) }
  filterLogs(levels: string[]): void { this.logFilter = levels.slice(); this.logScroll = 0; this.setPage('logs') }

  setSnapshot(snapshot: Snapshot, focus?: string): void { this.snapshot = snapshot; this.focus = focus; this.schedule() }
  setPage(page: Page): void { this.clearSelection(); this.page = page; this.schedule(); this.emit('page', page) }

  clear(): void { this.clearSelection(); this.consoleLines = []; this.consoleScroll = 0; this.setPage('console') }

  clearSelection(): void {
    this.copyRequest = (this.copyRequest ?? 0) + 1
    this.copyFeedback = ''
    if (this.copyTimer) { clearTimeout(this.copyTimer); this.copyTimer = undefined }
    if (this.selection) { this.selection = undefined; this.clipboard.cancel(); this.schedule() }
  }

  copySelection(): void {
    const selection = this.selection
    if (!selection?.moved) return
    const text = selection.text()
    if (!text) return
    this.copyFeedback = ''
    if (this.copyTimer) { clearTimeout(this.copyTimer); this.copyTimer = undefined }
    selection.dragging = false
    const request = this.copyRequest = (this.copyRequest ?? 0) + 1
    const current = () => !this.closed && request === this.copyRequest && this.selection === selection
    const failed = (error: unknown) => { if (current()) this.emit('copyFailed', error) }
    try {
      void this.clipboard.copy(text).then(status => {
        if (!current() || status === 'cancelled') return
        if (status === 'confirmed') this.clearSelection()
        this.copyFeedback = status === 'confirmed' ? this.text('Copied') : this.text('Copy request sent')
        this.copyFeedbackColor = status === 'confirmed' ? colors.ok : colors.info
        if (this.copyTimer) clearTimeout(this.copyTimer)
        this.copyTimer = setTimeout(() => { this.copyFeedback = ''; this.copyTimer = undefined; this.schedule() }, 2000)
        this.copyTimer.unref()
        this.schedule()
      }, failed)
    } catch (error) { failed(error) }
  }

  mouse(button: number, x: number, y: number, release: boolean): void {
    if (this.closed || x < 1 || y < 1) return
    if ((button & 3) === 2) {
      if (!release && !(button & 32) && x <= (process.stdout.columns || 80) && y <= (process.stdout.rows || 24)) this.copySelection()
      return
    }
    if ((button & 3) !== 0) return
    if (release) {
      if (!this.selection?.dragging) return
      this.selection.move(x, y); this.selection.dragging = false
      if (!this.selection.moved) this.clearSelection()
    } else if (button & 32) { if (this.selection?.dragging) this.selection.move(x, y) }
    else {
      this.clearSelection(); this.clipboard.cancel()
      this.selection = new Selection(this.frame.slice(), x, y, process.stdout.columns || 80)
    }
    this.schedule()
  }

  stateLines(): string[] {
    if (!this.snapshot) return [this.text('Initializing Core…')]
    return statusLines(this.snapshot, this.language, (text, color) => this.style(text, color), this.focus, { debug: this.debug, errors: this.errors, messages: this.errorMessages })
  }

  footer(rows: number): string[] {
    const modules = errorModules(this.snapshot, this.errors)
    if (!modules.length || rows < 6) return []
    return [modules.map(name => this.style('●', colors.error) + ' ' + clean(name)).join('  '), '']
  }

  suggestions(): { value: string; description: string; argument: boolean }[] {
    if (!this.ready || !this.line.startsWith('/') || this.cursor !== this.line.length || this.line === this.dismissedCompletion) return []
    if (this.completionQuery !== this.line) { this.completionQuery = this.line; this.completionIndex = 0 }
    const [matches] = complete(this.line, this.snapshot?.plugins.map(plugin => plugin.id) ?? [])
    const argument = /\s/.test(this.line)
    const items = matches.map(value => ({ value, argument, description: argument ? this.text(this.snapshot?.plugins.find(plugin => plugin.id === value)?.state ?? '') : this.text(commands.find(command => '/' + command.name === value)?.description ?? '') }))
    this.completionIndex = Math.max(0, Math.min(this.completionIndex, items.length - 1))
    return items
  }

  menu(): string[] {
    const items = this.suggestions()
    const rows = Math.max(1, process.stdout.rows || 24)
    const count = Math.min(5, items.length, Math.max(0, rows - 6 - this.footer(rows).length))
    if (!count) return []
    const start = Math.max(0, Math.min(this.completionIndex - count + 1, items.length - count))
    return items.slice(start, start + count).map((item, index) => {
      const selected = start + index === this.completionIndex
      const label = (selected ? '› ' : '  ') + item.value.padEnd(16) + '  ' + item.description
      return this.style(label, selected ? '\x1b[1;97m' : '\x1b[90m')
    })
  }

  acceptCompletion(): boolean {
    const item = this.suggestions()[this.completionIndex]
    if (!item) return false
    if (item.argument) this.line = this.line.replace(/\S*$/, item.value)
    else this.line = item.value + (commands.find(command => '/' + command.name === item.value)?.args ? ' ' : '')
    this.cursor = this.line.length
    this.dismissedCompletion = this.line
    this.schedule()
    return true
  }

  bodyRows(): number {
    const rows = Math.max(1, process.stdout.rows || 24)
    return Math.max(0, rows - 4 - this.footer(rows).length - this.menu().length)
  }

  scroll(older: number): void {
    if (older !== 0) this.clearSelection()
    const visible = this.bodyRows()
    if (!visible) return
    if (this.page === 'status') this.stateScroll = Math.max(0, Math.min(Math.max(0, this.stateLines().length - visible), this.stateScroll - older))
    else if (this.page === 'logs') this.logScroll = Math.max(0, Math.min(Math.max(0, this.visibleLogs().length - visible), this.logScroll + older))
    else this.consoleScroll = Math.max(0, Math.min(Math.max(0, this.consoleLines.length - visible), this.consoleScroll + older))
    if (older !== 0) this.schedule()
  }

  wheel(direction: number, x: number, y: number): void {
    if (this.closed || x > (process.stdout.columns || 80) || y < 3 || y > 2 + this.bodyRows()) return
    this.scroll(direction * 3)
  }

  render(): void {
    if (this.closed) return
    const columns = Math.max(1, process.stdout.columns || 80)
    const rows = Math.max(1, process.stdout.rows || 24)
    const pages = (['console', 'logs', 'status'] as Page[]).map(page => this.style(this.text(page === 'console' ? 'Console' : page === 'logs' ? 'Logs' : 'Status'), page === this.page ? '\x1b[1;97m' : '\x1b[90m'))
    const header = this.style(`me.CLI ${this.version}`, '\x1b[1m') + '  ' + pages.join('  ')
    const before = this.line.slice(0, this.cursor)
    let input = this.line
    let cursorColumn = width(before)
    while (cursorColumn > Math.max(0, columns - 5) && input) {
      const first = Array.from(input)[0]
      input = input.slice(first.length)
      cursorColumn -= width(first)
    }
    let hint = !this.ready ? this.text('Initializing Core…') : this.page === 'console' ? this.text('/help commands - Tab complete - ↑/↓ history - Ctrl+D exit - Ctrl+number switch pages') : this.page === 'logs' ? this.text(this.logScroll ? 'Log history - Ctrl+number switch pages' : 'Following me.init logs - Ctrl+number switch pages') : this.text('↑/↓ or PgUp/PgDn scroll - Ctrl+number switch pages')
    if (this.ready && width(hint) > columns) {
      hint = this.text(this.page === 'console' ? '/help - Tab complete - Ctrl+D exit - Ctrl+number pages' : 'Ctrl+number switch pages')
      if (width(hint) > columns) hint = this.text('Ctrl+number switch pages')
    }
    if (this.page === 'logs' && this.logFilter?.length) hint = this.logFilter.join(' ') + ' - ' + hint
    if (this.selection) hint = this.text('Right click or Ctrl+C copy - Esc cancel selection')
    if (this.copyFeedback) hint = this.copyFeedback
    const footer = [...this.footer(rows), ...this.menu(), this.style('› ', colors.info) + clean(input), this.style(hint, this.copyFeedback ? this.copyFeedbackColor : undefined)]
    const bodyRows = Math.max(0, rows - 2 - footer.length)
    this.scroll(0)
    let body: string[]
    if (this.page === 'logs') {
      const logs = this.visibleLogs(), end = Math.max(0, logs.length - this.logScroll)
      body = logs.slice(Math.max(0, end-bodyRows), end)
    } else if (this.page === 'status') body = this.stateLines().slice(this.stateScroll, this.stateScroll + bodyRows)
    else {
      const end = Math.max(0, this.consoleLines.length - this.consoleScroll)
      body = this.consoleLines.slice(Math.max(0, end-bodyRows), end)
    }
    const lines = rows === 1 ? [footer.at(-2)!] : rows < 4 ? [...Array.from({ length: rows-2 }, () => ''), ...footer.slice(-2)] : [header, '', ...Array.from({ length: bodyRows }, (_, i) => body[i] ?? ''), ...footer]
    if (!this.selection) this.frame = lines.map(line => fit(line, columns))
    let output = ''
    for (let i = 0; i < rows; i++) {
      const line = this.selection ? i === rows - 1 ? fit(this.style(hint, this.copyFeedback ? this.copyFeedbackColor : undefined), columns) : this.selection.highlight(this.selection.frame[i] ?? '', i) : this.frame[i]
      if (this.previous[i] !== line) output += `\x1b[${i+1};1H` + line
      this.previous[i] = line
    }
    const caret = `\x1b[${Math.max(1, rows-1)};${Math.max(1, Math.min(columns, cursorColumn+3))}H`
    if (output || caret !== this.previousCursor) process.stdout.write('\x1b[?25l' + output + caret + '\x1b[?25h')
    this.previousCursor = caret
  }

  key(text: string, key: readline.Key): void {
    if (this.closed || !key) return
    if (this.selection) {
      if (key.ctrl && key.name === 'c') {
        this.copySelection()
        return
      }
      this.clearSelection()
      if (key.name === 'escape') return
    }
    if (key.ctrl && /^[1-6]$/.test(key.name ?? '')) {
      const page = (['console', 'logs', 'status'] as Page[])[Number(key.name)-1]
      if (page) { if (page === 'status' && (this.focus || this.debug)) { this.focus = undefined; this.debug = false; this.stateScroll = 0 }; this.setPage(page) }
      return
    }
    if (key.ctrl && key.name === 'c') { if (this.listenerCount('SIGINT')) this.emit('SIGINT'); else process.emit('SIGINT'); return }
    if (key.ctrl && key.name === 'd' && !this.line) { if (this.ready) this.close(); else process.emit('SIGINT'); return }
    if (key.name === 'escape') {
      if (this.suggestions().length) { this.dismissedCompletion = this.line; this.schedule() }
      else this.emit('cancel')
      return
    }
    const suggestions = this.suggestions()
    if (suggestions.length && !key.ctrl && ['up', 'down'].includes(key.name ?? '')) {
      this.completionIndex = (this.completionIndex + (key.name === 'up' ? -1 : 1) + suggestions.length) % suggestions.length
      this.schedule(); return
    }
    if (key.name === 'tab' && this.acceptCompletion()) return
    if (key.name === 'return' || key.name === 'enter') {
      if (!this.ready) return
      if (suggestions.length) {
        const item = suggestions[this.completionIndex]
        const args = commands.find(command => '/' + command.name === item.value)?.args
        const needsArgument = !item.argument && Boolean(args && !args.startsWith('['))
        const completeArgument = item.argument && this.line.match(/\S*$/)?.[0] === item.value
        this.acceptCompletion()
        if (item.argument && !completeArgument || needsArgument) return
      }
      const line = this.line
      this.consoleScroll = 0
      this.line = ''; this.cursor = 0; this.historyIndex = -1
      if (line.trim()) { this.history = [line, ...this.history.filter(item => item !== line)].slice(0, 200); this.append('› ' + clean(line)) }
      this.emit('line', line)
    } else if (this.page === 'console' && ['pageup', 'pagedown'].includes(key.name ?? '')) {
      this.scroll((key.name === 'pageup' ? 1 : -1) * Math.max(1, this.bodyRows()))
    } else if (this.page !== 'console' && ['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name ?? '')) {
      const step = key.name === 'home' || key.name === 'end' ? Infinity : key.name?.startsWith('page') ? Math.max(1, this.bodyRows()) : 1
      this.scroll((['up', 'pageup', 'home'].includes(key.name!) ? 1 : -1) * step)
    } else if (key.name === 'up' || key.name === 'down') {
      if (this.historyIndex === -1) this.draft = this.line
      this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + (key.name === 'up' ? 1 : -1)))
      this.line = this.historyIndex === -1 ? this.draft : this.history[this.historyIndex]
      this.cursor = this.line.length
    } else if (key.ctrl && key.name === 'u') { this.line = this.line.slice(this.cursor); this.cursor = 0 }
    else if (key.name === 'home' || key.ctrl && key.name === 'a') this.cursor = 0
    else if (key.name === 'end' || key.ctrl && key.name === 'e') this.cursor = this.line.length
    else if (key.name === 'left') this.cursor -= Array.from(this.line.slice(0, this.cursor)).at(-1)?.length ?? 0
    else if (key.name === 'right') this.cursor += Array.from(this.line.slice(this.cursor))[0]?.length ?? 0
    else if (key.name === 'backspace') { const size = Array.from(this.line.slice(0, this.cursor)).at(-1)?.length ?? 0; this.line = this.line.slice(0, this.cursor-size) + this.line.slice(this.cursor); this.cursor -= size }
    else if (key.name === 'delete') this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + (Array.from(this.line.slice(this.cursor))[0]?.length ?? 0))
    else if (key.name === 'tab') {
      const [matches, part] = complete(this.line.slice(0, this.cursor), this.snapshot?.plugins.map(plugin => plugin.id) ?? [])
      if (matches.length === 1) { const value = matches[0].slice(part.length); this.line = this.line.slice(0, this.cursor) + value + this.line.slice(this.cursor); this.cursor += value.length }
      else if (matches.length) this.append(matches.join('  '))
    } else if (text && !key.ctrl && !key.meta) {
      this.insert(text)
    }
    this.schedule()
  }

  insert(text: string): void {
    this.clearSelection()
    const value = clean(text).replace(/[\r\n]/g, '')
    if (value && this.line.length + value.length <= 4096) { this.line = this.line.slice(0, this.cursor) + value + this.line.slice(this.cursor); this.cursor += value.length; this.dismissedCompletion = ''; this.schedule() }
  }

  write(_value: null, key: { ctrl: boolean; name: string }): void { this.key('', key) }
  prompt(_preserve?: boolean): void { this.schedule() }
  getCursorPos(): { rows: number; cols: number } { return { rows: 0, cols: width(this.line.slice(0, this.cursor)) } }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.copyTimer) clearTimeout(this.copyTimer)
    process.stdin.off('data', this.dataListener)
    this.keyboard.close()
    this.clipboard.close()
    process.stdout.off('resize', this.resizeListener)
    process.stdin.setRawMode(this.wasRaw)
    process.stdin.pause()
    process.stdout.write('\x1b[<u\x1b[>4m\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l')
    this.emit('close')
  }
}
