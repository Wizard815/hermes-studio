import { join, resolve } from 'node:path'
import { listHermesPlugins, setHermesPluginEnabled } from '../services/plugins/plugins'
import {
  MCP_SERVE_SERVER_NAME, RECOMMENDED_HERMES_PLUGINS, RECOMMENDED_PLUGINS_ENV, readRecommendedState, recommendedAutoInstallSetting,
  scheduleRecommendedPlugins,
} from '../services/plugins/recommended'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { writeAppConfig } from '../../studio/public/app-config'

export async function list(ctx: any) {
  try {
    ctx.body = await listHermesPlugins(ctx.state?.profile?.name)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to discover Hermes plugins' }
  }
}

export async function enable(ctx: any) {
  await setPluginEnabled(ctx, true)
}

export async function disable(ctx: any) {
  await setPluginEnabled(ctx, false)
}

async function setPluginEnabled(ctx: any, enabled: boolean) {
  try {
    const key = String(ctx.params?.key || '').trim()
    if (!key) {
      ctx.status = 400
      ctx.body = { error: 'Plugin key is required' }
      return
    }
    ctx.body = await setHermesPluginEnabled(ctx.state?.profile?.name, key, enabled)
  } catch (err: any) {
    const message = err.message || 'Failed to update Hermes plugin'
    ctx.status = message.includes('not found') ? 404 : message.includes('cannot be managed') ? 400 : 500
    ctx.body = { error: message }
  }
}

/** The recommended official plugins, the auto-install switch and what was done for this profile. */
export async function recommended(ctx: any) {
  try {
    const profile = ctx.state?.profile?.name || getActiveProfileName() || 'default'
    const [setting, state] = await Promise.all([
      recommendedAutoInstallSetting(),
      readRecommendedState().catch(() => null),
    ])
    const home = resolve(getProfileDir(profile))
    ctx.body = {
      plugins: [...RECOMMENDED_HERMES_PLUGINS],
      autoInstall: setting.enabled,
      disabledByEnv: setting.disabledByEnv,
      env: RECOMMENDED_PLUGINS_ENV,
      envFile: join(home, '.env'),
      mcpServerName: MCP_SERVE_SERVER_NAME,
      profile: state?.homes?.[home] || null,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to read recommended plugins' }
  }
}

/** Settings switch: turning it back on runs the install for profiles not done yet. */
export async function setRecommended(ctx: any) {
  const value = ctx.request.body?.autoInstall
  if (typeof value !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'autoInstall must be true or false' }
    return
  }
  await writeAppConfig({ recommendedHermesPlugins: value })
  const setting = await recommendedAutoInstallSetting()
  if (setting.enabled) void scheduleRecommendedPlugins()
  ctx.body = { autoInstall: setting.enabled, disabledByEnv: setting.disabledByEnv }
}
