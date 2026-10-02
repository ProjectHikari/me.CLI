import { clean, colors } from './display.mts'
import { t, type Language } from './i18n.mts'
import type { Snapshot } from './protocol.mts'

export type StatusOptions = { debug?: boolean; errors?: ReadonlySet<string>; messages?: ReadonlyMap<string, string> }

export function statusLines(snapshot: Snapshot, language: Language, style: (text: string, color?: string) => string, focus?: string, options: StatusOptions = {}): string[] {
  const text = (value: string, params: Record<string, string | number> = {}) => t(language, value, params)
  const plugins = snapshot.plugins.filter(plugin => !focus || plugin.id === focus)
  const resources = plugins.flatMap(plugin => plugin.resources.map(resource => ({ ...resource, owner: plugin.id, state: plugin.state })))
  const lines = [style(`Core ${snapshot.version} - ${text(snapshot.state)}`, snapshot.state === 'running' ? colors.ok : colors.warn), '']
  const heading = (name: string, count: number) => { lines.push(style(text(name) + ' ' + count, '\x1b[1;97m')) }
  const coreError = options.messages?.get('core') ?? options.messages?.get('Core')
  if (coreError && (!focus || focus.toLowerCase() === 'core')) lines.push('  ' + style(clean(options.debug ? coreError : coreError.split('\n')[0]), colors.error), '')
  if (focus?.toLowerCase() === 'core') {
    if (options.debug) for (const [name, value] of Object.entries(snapshot.stats)) lines.push('  ' + text(clean(name)) + ': ' + value)
    return lines
  }
  const errors = (plugin: typeof plugins[number]) => [...new Set([plugin.error, options.messages?.get(plugin.id)].filter((error): error is string => Boolean(error)))]
  const resourceLine = (resource: typeof resources[number]) => '  ' + clean(resource.owner) + ' - ' + text(clean(resource.kind)) + ' - ' + text(clean(resource.label)) + ' - ' + style('[' + text(resource.dirty ? 'dirty' : 'owned') + ']', resource.dirty ? colors.error : '\x1b[90m') + (resource.error ? ' - ' + style(clean(options.debug ? resource.error : resource.error.split('\n')[0]), colors.error) : '')
  heading('Plugins', plugins.length)
  if (!options.debug) {
    for (const plugin of plugins) {
      const failed = ['Failed', 'Quarantined'].includes(plugin.state)
      const reported = options.errors?.has(plugin.id) || errors(plugin).length > 0
      const dirty = resources.filter(resource => resource.owner === plugin.id && (resource.dirty || resource.error))
      const color = failed ? colors.error : plugin.state === 'Running' ? colors.ok : colors.warn
      lines.push('  ' + clean(plugin.id) + ' - ' + style(text(plugin.state), color) + (!failed && (reported || dirty.length) ? ' - ' + style('[ERROR]', colors.error) : ''))
      if (plugin.missing.length) lines.push('    ' + style(text('missing') + ': ' + clean(plugin.missing.join(', ')), colors.warn))
      if (failed || reported || dirty.length) {
        for (const error of new Set(errors(plugin).map(error => error.split('\n')[0]))) lines.push('    ' + style(clean(error), colors.error))
        if (plugin.required?.length && !plugin.missing.length) lines.push('    ' + text('Required') + ': ' + clean(plugin.required.join(', ')))
        if (dirty.length) {
          lines.push('    ' + style(text('Dirty') + ' ' + dirty.length, colors.error))
          lines.push(...dirty.map(resourceLine))
        }
      }
    }
    return lines
  }
  for (const plugin of plugins) {
    const color = plugin.state === 'Running' ? colors.ok : ['Failed', 'Quarantined'].includes(plugin.state) ? colors.error : colors.warn
    lines.push('  ' + clean(plugin.id) + ' - ' + style(text(plugin.state), color) + ' - generation ' + plugin.generation + ' - ' + text('Enabled') + ' ' + text(plugin.enabled ? 'yes' : 'no'))
    for (const [name, keys] of [['Provides', plugin.provides], ['Required', plugin.required], ['Optional', plugin.optional]] as const) {
      if (keys?.length) lines.push('    ' + text(name) + ': ' + clean(keys.join(', ')))
    }
    if (plugin.missing.length) lines.push('    ' + style(text('missing') + ': ' + clean(plugin.missing.join(', ')), colors.warn))
    for (const error of errors(plugin)) lines.push('    ' + style(clean(error), colors.error))
  }
  lines.push('')
  for (const [name, kind] of [['Services', 'service'], ['Tasks', 'task'], ['Timers', 'timer'], ['Listeners', 'listener'], ['Inflight', 'callback']] as const) {
    const items = resources.filter(resource => resource.kind === kind)
    heading(name, items.length)
    for (const resource of items) {
      lines.push(resourceLine(resource))
      if (kind === 'service') {
        const key = resource.label.replace(/^service: /, '')
        const consumers = snapshot.plugins.filter(plugin => plugin.required?.includes(key)).map(plugin => plugin.id)
        lines.push('    ' + text('Availability') + ': ' + text(resource.state === 'Running' && !resource.dirty ? 'available' : 'unavailable'))
        if (consumers.length) lines.push('    ' + text('Required by') + ': ' + clean(consumers.join(', ')))
      }
    }
    if (!items.length) lines.push('  ' + style(text('None')))
    lines.push('')
  }
  heading('Resources', resources.length)
  lines.push(...resources.map(resourceLine))
  if (!resources.length) lines.push('  ' + style(text('None')))
  lines.push('')
  const dirty = resources.filter(resource => resource.dirty)
  heading('Dirty', dirty.length)
  lines.push(...dirty.map(resourceLine))
  if (!dirty.length) lines.push('  ' + style(text('None')))
  return lines
}
