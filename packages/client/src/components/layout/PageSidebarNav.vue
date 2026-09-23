<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { useSessionSearch } from '@/composables/useSessionSearch'

type ActiveSection = 'chat' | 'history' | 'connections' | 'agents' | 'models' | 'group' | 'global' | 'workflow' | 'browser'

const props = defineProps<{\n  active: ActiveSection\n  primaryLabel?: string\n}>()\n\nconst emit = defineEmits<{\n  primary: []\n  browser_open: []\n}>()\n\nconst { t } = useI18n()\
const router = useRouter()\
const { openSessionSearch } = useSessionSearch()\
const canManageAgents = computed(() => isStoredSuperAdmin())\
\nconst primaryText = computed(() => props.primaryLabel || t('chat.newChat'))\n\nfunction openChat() {\n  if (props.active === 'chat') return\n  void router.push({ name: 'hermes.chat' })\n}\n\nfunction openHistory() {\n  if (props.active === 'history') return\
  void router.push({ name: 'hermes.history' })\n}\n\nfunction openConnections() {\n  if (props.active === 'connections') return\
  void router.push({ name: 'hermes.connections' })\n}\n\nfunction openAgentManager() {\n  if (props.active === 'agents') return\
  void router.push({ name: 'hermes.agentManager' })\n}\n\nfunction openModels() {\n  if (props.active === 'models') return\
  void router.push({ name: 'hermes.models' })\n}\n\nfunction openGroupChat() {\n  if (props.active === 'group') return\
  void router.push({ name: 'hermes.groupChat' })\n}\n\nfunction openWorkflow() {\n  if (props.active === 'workflow') return\
  void router.push({ name: 'hermes.workflow' })\n}\n\nfunction openApiRelay() {\n  if (typeof window === 'undefined') return\
  window.open('https://apikey.fan/register?aff=LIBAPI', '_blank', 'noopener,noreferrer')\n}\n\nfunction openBrowser() {\n  emit('browser_open')\n}\n</script>

<template>\n  <div class=\"page-sidebar-nav\">\n    <div class=\"page-sidebar-tabs\" role=\"tablist\" aria-label=\"Chat actions\">\n      <button\n        class=\"page-sidebar-tab\"\
        type=\"button\"\
        @click=\"emit('primary')\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"2\"\
        >\n          <line x1=\"12\" y1=\"5\" x2=\"12\" y2=\"19\" />\n          <line x1=\"5\" y1=\"12\" x2=\"19\" y2=\"12\" />\
        </svg>\n        <span>{{ primaryText }}</span>\
      </button>\n      <button class=\"page-sidebar-tab\" type=\"button\" @click=\"openSessionSearch\">\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <circle cx=\"11\" cy=\"11\" r=\"7\" />\n          <path d=\"m20 20-3.5-3.5\" />\n        </svg>\
        <span>{{ t('sidebar.search') }}</span>\
      </button>\n      <button\n        class=\"page-sidebar-tab\"\
        :class=\"{ active: active === 'connections' }\"\
        type=\"button\"\
        :aria-current=\"active === 'connections' ? 'page' : undefined\"\
        @click=\"openConnections\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <circle cx=\"18\" cy=\"5\" r=\"2.5\" />\
          <circle cx=\"6\" cy=\"12\" r=\"2.5\" />\
          <circle cx=\"18\" cy=\"19\" r=\"2.5\" />\
          <path d=\"m8.2 10.7 7.6-4.4M8.2 13.3l7.6 4.4\" />\n        </svg>\n        <span>{{ t('sidebar.connections') }}</span>\
      </button>\n      <button\n        v-if=\"canManageAgents\"\
        class=\"page-sidebar-tab\"\
        :class=\"{ active: active === 'agents' }\"\
        type=\"button\"\
        :aria-current=\"active === 'agents' ? 'page' : undefined\"\
        @click=\"openAgentManager\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <path d=\"M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1\" />\n        </svg>\
        <span>{{ t('sidebar.agents') }}</span>\
      </button>\n      <button\
        class=\"page-sidebar-tab\"\
        :class=\"{ active: active === 'models' }\"\
        type=\"button\"\
        :aria-current=\"active === 'models' ? 'page' : undefined\"\
        @click=\"openModels\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <circle cx=\"12\" cy=\"12\" r=\"3\" />\
          <path d=\"M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1\" />\
        </svg>\
        <span>{{ t('sidebar.models') }}</span>\
      </button>\n      <button\
        class=\"page-sidebar-tab\"\
        :class=\"{ active: active === 'group' }\"\
        type=\"button\"\
        :aria-current=\"active === 'group' ? 'page' : undefined\"\
        @click=\"openGroupChat\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <path d=\"M17 21v-2a4 4 0 00-3-3H8a4 4 0 00-4 4v2\" />\n          <circle cx=\"9\" cy=\"7\" r=\"4\" />\n          <path d=\"M23 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2\" />\n          <path d=\"M9 7V4a2 2,0 012-2h4a2 2,0 012 2v3\" />\n        </svg>\
        <span>{{ t('sidebar.group') }}</span>\
      </button>\n      <button\
        class=\"page-sidebar-tab\"\
        :class=\"{ active: active === 'workflow' }\"\
        type=\"button\"\
        :aria-current=\"active === 'workflow' ? 'page' : undefined\"\
        @click=\"openWorkflow\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <path d=\"M22 11.08V12a10 10,0 11-7.93-9.87\" />\n          <polyline points=\"22 4 12 14.01 9 11.01\" />\n          <line x1=\"22\" y1=\"9\" x2=\"9\" y2=\"9\" />\n        </svg>\
        <span>{{ t('sidebar.workflow') }}</span>\
      </button>\n      <button\
        class=\"page-sidebar-tab\"\
        type=\"button\"\
        @click=\"openApiRelay\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <path d=\"M18 13v6a2 2,0 01-2 2H8\" />\n          <polyline points=\"15 3 21 3 21 9\" />\n          <line x1=\"10\" y1=\"14\" x2=\"21\" y2=\"3\" />\n        </svg>\n        <span>{{ t('sidebar.apiRelay') }}</span>\
      </button>\n      <button\
        class=\"page-sidebar-tab\"\
        type=\"button\"\
        @click=\"openBrowser\"\
      >\n        <svg\n          width=\"15\"\
          height=\"15\"\
          viewBox=\"0 0 24 24\"\
          fill=\"none\"\
          stroke=\"currentColor\"\
          stroke-width=\"1.8\"\
          stroke-linecap=\"round\"\
          stroke-linejoin=\"round\"\
          aria-hidden=\"true\"\
        >\n          <circle cx=\"12\" cy=\"12\" r=\"3\" />\n          <path d=\"M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1\" />\n        </svg>\
        <span>{{ t('sidebar.browser') }}</span>\
      </button>\n    </div>\n  </div>\n</template>