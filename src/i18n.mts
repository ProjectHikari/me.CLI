import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'

export type Language = 'zh' | 'en'
const catalog: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('../../me.init/locale.json', import.meta.url), 'utf8'))
const local: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('../locale.json', import.meta.url), 'utf8'))

export function t(language: Language, template: string, params: Record<string, string | number> = {}): string {
  return (local[language]?.[template] ?? catalog[language]?.[template] ?? template).replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

export function languageValue(value: string | undefined): Language | undefined {
  if (value === undefined) return undefined
  if (value === 'zh' || value === 'en') return value
  throw new Error('Language must be zh or en / 语言必须是zh或en')
}

export function preferencePath(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'testbot', 'cli.json')
}

export async function savedLanguage(file: string): Promise<Language | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))?.language
    return value === 'zh' || value === 'en' ? value : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function saveLanguage(file: string, language: Language): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ language }) + '\n', { mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export async function selectLanguage(explicit?: string, ask = false): Promise<Language | undefined> {
  const override = languageValue(explicit ?? process.env.ME_LANGUAGE)
  if (override) return override
  const file = preferencePath()
  const saved = await savedLanguage(file)
  if (saved) return saved
  if (!ask) return 'en'
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  const abort = new AbortController()
  input.on('SIGINT', () => abort.abort())
  input.on('close', () => abort.abort())
  process.stdout.write('\n  选择语言 / Choose language\n  1 中文\n  2 English\n\n')
  try {
    for (;;) {
      const answer = (await input.question('  [1/2] (1): ', { signal: abort.signal })).trim().toLowerCase()
      const language = ['', '1', 'zh', '中文'].includes(answer) ? 'zh' : ['2', 'en', 'english'].includes(answer) ? 'en' : undefined
      if (!language) { process.stdout.write('  请输入1或2 / Enter 1 or 2\n'); continue }
      await saveLanguage(file, language)
      return language
    }
  } catch (error) {
    if (abort.signal.aborted) return undefined
    throw error
  } finally { input.close() }
}
