<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchUiSkills, installedCount, targetsForSkillsPage, type UiSkillsInfo, type UiSkillStatus } from '@/api/studio/ui-skills'

/** Skills page: the UI skills Studio bundles (docs/ui-skills.md) and where this page's agent has them. */
const props = defineProps<{ target: string; profile?: string | null }>()

const { t } = useI18n()
const info = ref<UiSkillsInfo | null>(null)
const open = ref(false)

onMounted(async () => {
  try { info.value = await fetchUiSkills() } catch { info.value = null }
})

const targets = computed(() => info.value ? targetsForSkillsPage(info.value, props.target, props.profile) : [])
const total = computed(() => info.value?.skills.length || 0)
const here = computed(() => targets.value[0] || null)
const summary = computed(() => {
  if (!info.value) return ''
  const count = here.value ? t('uiSkills.countHere', { count: installedCount(here.value), total: total.value }) : t('uiSkills.notHere')
  return info.value.enabled ? count : `${count} ${t('uiSkills.off')}`
})

const STATUS_TYPE: Record<UiSkillStatus, 'success' | 'warning' | 'default' | 'info'> = {
  installed: 'success', edited: 'info', removed: 'default', 'kept-existing': 'info', pending: 'warning',
}
</script>

<template>
  <section v-if="info && total" class="ui-skills-card" data-theme-surface="card" data-testid="ui-skills-card">
    <div class="ui-skills-row">
      <h3 class="ui-skills-title">{{ t('uiSkills.title') }}</h3>
      <span class="ui-skills-summary" role="status">{{ summary }}</span>
      <span class="spacer" />
      <button
        type="button"
        class="ui-skills-toggle"
        :aria-expanded="open"
        aria-controls="ui-skills-details"
        @click="open = !open"
      >
        {{ open ? t('uiSkills.hide') : t('uiSkills.show') }}
      </button>
    </div>
    <div v-if="open" id="ui-skills-details" class="ui-skills-details">
      <p class="ui-skills-credit">
        {{ t('uiSkills.credit', { author: info.source.author, licence: info.source.licence }) }}
        <a :href="info.source.repo" target="_blank" rel="noopener">{{ t('uiSkills.source') }}</a>
      </p>
      <ul class="ui-skills-list">
        <li v-for="skill in info.skills" :key="skill.name">
          <span class="ui-skills-name">{{ skill.name }}</span>
          <NTag v-if="here" size="small" round :type="STATUS_TYPE[here.skills[skill.name] || 'pending']">
            {{ t(`uiSkills.status.${here.skills[skill.name] || 'pending'}`) }}
          </NTag>
          <span class="ui-skills-desc">{{ skill.description }}</span>
        </li>
      </ul>
      <p v-if="here" class="ui-skills-hint">{{ t('uiSkills.folder', { dir: here.dir }) }}</p>
      <p class="ui-skills-hint">{{ t('uiSkills.manageHint', { env: info.env }) }}</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ui-skills-card {
  margin: calc(8px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  flex-shrink: 0;
  max-height: 45vh;
  overflow-y: auto;
  padding: calc(8px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.ui-skills-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 32px; }
.ui-skills-title { margin: 0; font-size: calc(var(--font-size-base, 14px) * 14 / 14); font-weight: 600; }
.ui-skills-summary { color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
.spacer { flex: 1; }

.ui-skills-toggle {
  min-height: 32px;
  padding: 0 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  background: transparent;
  color: $accent-primary;
  font: inherit;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  cursor: pointer;

  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.ui-skills-details { padding-top: 8px; }
.ui-skills-credit, .ui-skills-hint { margin: 0 0 8px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.ui-skills-credit a { color: $accent-primary; }
.ui-skills-hint { color: $text-muted; word-break: break-all; }

.ui-skills-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 6px 16px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}

.ui-skills-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.ui-skills-name { font-family: monospace; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
.ui-skills-desc { flex-basis: 100%; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
</style>
