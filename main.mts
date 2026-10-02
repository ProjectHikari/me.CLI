import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { EventEmitter } from 'node:events'
import { Client, RuntimeError } from './src/client.mts'
import { parseCommand, VERSION, CommandError } from './src/commands.mts'
import { Terminal } from './src/terminal.mts'
import type { Log } from './src/protocol.mts'
import { selectLanguage, t } from './src/i18n.mts'

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, config: { type: 'string' }, python: { type: 'string' }, language: { type: 'string' },
    command: { type: 'string', multiple: true, short: 'c' }, plain: { type: 'boolean' },
    json: { type: 'boolean' }, inline: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } })
  if (values.version) { console.log(VERSION); return 0 }
  const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const scripted = [...values.command ?? [], ...(positionals.length ? [positionals.join(' ')] : [])]
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !values.json && !scripted.length)
  const language = await selectLanguage(values.language, interactive && !values.help)
  if (!language) return 0
  if (values.help) {
    console.log(t(language, 'Usage: me [--language zh|en] [--config path] [--plain | --json] [-c "command"] [command]'))
    console.log('\n' + t(language, 'Start me.init and Core automatically. Without a command, open an interactive CLI.') + '\n')
    for (const [flag, description] of [
      ['--root path', 'Testbot directory'], ['--config path', 'Plugin configuration (default: me.init/plugins.json)'],
      ['--python path', 'Python 3.11+ executable'], ['--language zh|en', 'Language for this run (zh or en)'],
      ['-c command', 'Run a command; repeat for a sequence'], ['--plain', 'Disable colors'],
      ['--json', 'Emit JSON Lines'], ['--inline', 'Use terminal scrollback instead of fixed pages'], ['-v, --version', 'Show version'],
    ]) console.log('  ' + flag.padEnd(20) + t(language, description))
    console.log('\n' + t(language, 'Commands') + ': status, debug, plugins, mount, clear, start, stop, reload, retryCleanup, help, quit')
    return 0
  }
  const terminal = new Terminal(Boolean(values.plain), Boolean(values.json), interactive, language, Boolean(values.inline))
  terminal.banner(root)
  const client = new Client(values.python ?? process.env.ME_PYTHON ?? 'python3', root, values.config ? path.resolve(values.config) : undefined, language)
  client.on('log', (event: Log) => terminal.log(event))
  client.on('state', snapshot => terminal.update(snapshot))
  let active: string | undefined
  let shuttingDown = false
  let closing = false
  let code = 0
  const log = (level: string, message: string) => terminal.log({ type: 'log', time: new Date().toISOString(), level, source: 'me.cli', message: t(language, message) })
  const close = async (): Promise<boolean> => {
    if (closing) return false
    closing = true
    try {
      if (!client.exited) {
        if (active) { client.cancel(active); log('warn', 'Waiting for the current operation to finish'); return false }
        const request = client.request('shutdown')
        active = request.id
        try { await request.result } finally { active = undefined }
      }
      shuttingDown = true
      terminal.close()
      return true
    } catch (error) {
      if (!interactive) code = 1
      log(error instanceof RuntimeError ? 'failed' : 'error', error instanceof Error ? error.message : String(error))
      log('warn', 'Core still owns dirty resources. Use /status and /retryCleanup, then /quit')
      return false
    } finally { closing = false }
  }
  const execute = async (line: string): Promise<void> => {
    try {
      const command = parseCommand(line, language)
      if (!command) return
      if (command.method === 'help') { terminal.help(); return }
      if (command.method === 'clear') { terminal.clear(); return }
      if (command.method === 'console' || command.method === 'logs') { terminal.page(command.method); return }
      if (command.method === 'shutdown') { await close(); return }
      if (command.method === 'status' || command.method === 'debug') {
        terminal.page('status')
        terminal.prompt()
        const core = command.method === 'debug' && command.plugin?.toLowerCase() === 'core'
        terminal.status(await client.request('status', core ? undefined : command.plugin).result, command.plugin, command.method === 'debug')
        return
      }
      if (active) { log('warn', 'An operation is still running. Esc or Ctrl+C requests cancellation'); return }
      if (command.method === 'mount') terminal.page('console')
      const previous = new Set(client.snapshot?.plugins.map(plugin => plugin.id))
      const request = client.request(command.method, command.plugin, command.path ? path.resolve(command.path) : undefined)
      active = request.id
      terminal.prompt()
      try {
        const snapshot = await request.result
        terminal.operation(snapshot, command.plugin)
        if (command.method === 'mount' && !values.json) {
          for (const plugin of snapshot.plugins.filter(plugin => !previous.has(plugin.id))) {
            terminal.write('  ' + terminal.style(t(language, 'Mounted {plugin}', { plugin: plugin.id }), '\x1b[32m'))
          }
        }
      }
      finally { active = undefined }
    } catch (error) {
      if (!interactive) code = 1
      log(error instanceof RuntimeError || error instanceof CommandError ? 'failed' : 'error', error instanceof Error ? error.message : String(error))
      if (error instanceof RuntimeError) terminal.status(error.snapshot, terminal.screen?.focus, terminal.screen?.debug)
    }
  }
  const abort = () => {
    if (active) { client.cancel(active); log('warn', 'Cancellation requested; resources are still tracked until completion') }
  }
  const signal = () => { client.terminate() }
  process.on('SIGTERM', signal)
  process.on('SIGHUP', signal)
  process.on('SIGINT', signal)
  process.stdout.on('error', signal)
  try {
    const ready = await client.ready
    if (values.json) process.stdout.write(JSON.stringify({ type: 'ready', snapshot: ready }) + '\n')
    else if (!scripted.length) terminal.operation(ready)
    if (scripted.length) {
      for (const line of scripted) { if (shuttingDown) break; await execute(line) }
      if (!shuttingDown && !(await close())) { client.terminate(); shuttingDown = true }
    } else for (;;) {
      const rl = terminal.openInput()
      const inputEvents: EventEmitter = rl
      let lastInterrupt = 0
      let work: Promise<void> = Promise.resolve()
      let eof = false
      inputEvents.on('SIGINT', () => {
        if (active) { abort(); return }
        if (rl.line) { rl.write(null, { ctrl: true, name: 'u' }); return }
        if (Date.now() - lastInterrupt < 1500) { void close().then(() => terminal.prompt()); return }
        lastInterrupt = Date.now()
        log('warn', 'Press Ctrl+C again to close Core and exit')
      })
      inputEvents.on('page', (page: string) => { if (page === 'status' && !client.exited) void client.request('status').result.catch(error => log('error', String(error))) })
      inputEvents.on('cancel', abort)
      const keypress = (_text: string, key: { name: string }) => { if (key.name === 'escape' && active) abort() }
      process.stdin.on('keypress', keypress)
      const hostClosed = () => {
        if (!closing && !shuttingDown) log('error', 'Runtime host disconnected')
        terminal.close()
      }
      client.once('closed', hostClosed)
      if (interactive && !terminal.fixed) terminal.write(terminal.style('  ' + t(language, '/help commands - Tab complete - ↑/↓ history - Ctrl+D exit') + '\n'))
      terminal.prompt()
      await new Promise<void>(resolve => {
        inputEvents.on('line', (line: string) => {
          terminal.prompting = false
          if (interactive) {
            try {
              const command = parseCommand(line, language)
              if (command?.method === 'help' || command?.method === 'clear' || command?.method === 'console' || command?.method === 'logs') {
                void execute(line).finally(() => terminal.prompt())
                return
              }
            } catch {}
          }
          if (interactive && active) {
            try {
              const command = parseCommand(line, language)
              if (command?.method === 'status' || command?.method === 'debug' || command?.method === 'help' || command?.method === 'clear' || command?.method === 'console' || command?.method === 'logs') {
                void execute(line).finally(() => terminal.prompt())
                return
              }
            } catch {}
            log('warn', 'An operation is still running. Esc or Ctrl+C requests cancellation')
            terminal.prompt()
            return
          }
          work = work.then(async () => {
            if (shuttingDown || client.exited) return
            await execute(line)
            if (!shuttingDown && !eof) terminal.prompt()
          })
        })
        inputEvents.once('close', () => { eof = true; if (active) client.cancel(active); void work.finally(resolve) })
      })
      process.stdin.off('keypress', keypress)
      client.off('closed', hostClosed)
      if (shuttingDown || client.exited || await close()) break
      if (interactive) {
        log('warn', 'Exit deferred until cleanup completes. Use /retryCleanup')
        process.stdin.resume()
        continue
      } else {
        log('error', 'Input closed before cleanup completed')
        client.terminate()
        break
      }
    }
    const exited = await client.closed
    return exited || code
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error))
    client.terminate()
    await client.closed
    return 1
  } finally {
    terminal.close()
    process.off('SIGTERM', signal)
    process.off('SIGHUP', signal)
    process.off('SIGINT', signal)
    process.stdout.off('error', signal)
  }
}

main().then(code => { process.exitCode = code }).catch(error => { console.error(`[ERROR] ${error.message}`); process.exitCode = 1 })
