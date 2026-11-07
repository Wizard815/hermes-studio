import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import HerdrCenter from '../../../packages/client/src/components/coding-agents/herdr/HerdrCenter.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The herdr center is real; the spec mocks the API and swallows sockets.
const sessionId = new URLSearchParams(location.search).get('session') || 'herdr-aaa'
const active = ref(true)
;(window as any).herdrCenterFixture = { setActive: (value: boolean) => { active.value = value } }
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [
      h(HerdrCenter, { sessionId, active: active.value }),
    ]),
  }) }),
})
app.use(createPinia()); app.use(await i18nReady)
app.mount('#app')
