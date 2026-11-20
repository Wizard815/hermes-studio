import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import HerdrCenter from '../../../packages/client/src/components/coding-agents/herdr/HerdrCenter.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import { useHerdrStore } from '../../../packages/client/src/stores/hermes/herdr'
import '../../../packages/client/src/styles/global.scss'

// The herdr center is real; the spec mocks the API and swallows sockets.
// ?session=none: herdr mode with no herdr chat open.
const requested = new URLSearchParams(location.search).get('session') || 'herdr-aaa'
const sessionId = requested === 'none' ? '' : requested
const active = ref(true)
// ?header=1: the bar goes into a page header row, as in Studio's chat page.
const withHeader = new URLSearchParams(location.search).get('header') === '1'
const headerSlot = ref<HTMLElement | null>(null)
const opened: string[] = []
const fixture: any = { setActive: (value: boolean) => { active.value = value }, opened, newChats: 0 }
;(window as any).herdrCenterFixture = fixture
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
    default: () => h('div', { style: { display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' } }, [
      withHeader ? h('div', { class: 'studio-page-header', 'data-testid': 'fixture-header' }, [
        h('header', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', minWidth: 0 } }, [
          h('span', { style: { flex: '1 1 auto', minWidth: '40px', overflow: 'hidden', whiteSpace: 'nowrap' } }, 'Chat title'),
          h('div', { ref: headerSlot, style: { display: 'flex', minWidth: 0, flex: '0 1 auto' } }),
        ]),
      ]) : null,
      h('main', { style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } }, [
        h(HerdrCenter, { sessionId, active: active.value, headerTarget: headerSlot.value, onOpenChat: (id: string) => opened.push(id), onNewChat: () => { fixture.newChats += 1 } }),
      ]),
    ]),
  }) }),
})
app.use(createPinia()); app.use(await i18nReady)
app.mount('#app')
fixture.store = useHerdrStore()
