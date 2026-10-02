import { run } from '../core/bridge/sdk/typescript/sdk.mts'
import { commands, VERSION } from './src/commands.mts'
import { t, languageValue } from './src/i18n.mts'

const language = languageValue(process.env.ME_LANGUAGE) ?? 'en'

await run(async ctx => {
  const init = await ctx.call('me.init.info', 'info', null)
  await ctx.provide('me.cli.info', async (method) => {
    if (method !== 'info') throw new Error(`unknown method ${method}`)
    return { name: ctx.pluginId, version: VERSION, generation: ctx.generation, language, commands: commands.map(command => ({ ...command, description: t(language, command.description) })), init }
  })
})
