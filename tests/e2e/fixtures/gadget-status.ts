import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import GadgetStatusPanel from '../../../packages/client/src/components/hermes/connections/GadgetStatusPanel.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Connections → MCU devices → Hermes Gadget is real; the spec mocks the API.
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
    default: () => h('main', { style: { width: '100vw' } }, [h(GadgetStatusPanel)]),
  }) }),
})
app.use(createPinia()); app.use(await i18nReady)
app.mount('#app')
