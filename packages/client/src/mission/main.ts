import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { i18nReady } from '@/i18n'
import '@/styles/global.scss'
import MissionRoot from './MissionRoot.vue'

/**
 * herdr Mission view: served by Studio at /mission/ (so it shares Studio's
 * origin and tunnel port) and on its own port. It reuses Studio's API, theme,
 * sign-in token and herdr components.
 */
function storedPreference(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

const brightness = storedPreference('hermes_brightness', 'system')
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (brightness === 'dark' || (brightness === 'system' && prefersDark)) document.documentElement.classList.add('dark')

async function mount() {
  const app = createApp(MissionRoot)
  app.use(createPinia())
  app.use(await i18nReady)
  app.mount('#app')
}

void mount().catch(error => {
  console.error('[mission] failed to start', error)
  const root = document.getElementById('app')
  if (root) root.textContent = `herdr Mission could not start: ${error instanceof Error ? error.message : String(error)}`
})
