<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  checkSkillshare,
  fetchSkillshare,
  installSkillshare,
  syncSkillshare,
  updateSkillshare,
  type SkillshareItem,
  type SkillshareKind,
  type SkillshareOverview,
  type SkillshareResult,
} from '@/api/studio/command-center'
import { fetchSkills } from '@/api/hermes/skills'

/**
 * Skills (runkids/skillshare's herdr panel): when the `skillshare` CLI is on
 * the Studio server, its Overview (what needs a sync, every target, updates
 * per kind) and Library, with Sync, Update and Install behind a confirmation;
 * otherwise how to install it. Studio's own Hermes skills are counted too.
 */
const { t } = useI18n()
const toast = useMessage()
const dialog = useDialog()
const overview = ref<SkillshareOverview | null>(null)
const error = ref('')
const loading = ref(false)
const busy = ref('')
const view = ref<'overview' | 'library'>('overview')
const kind = ref<SkillshareKind | 'all'>('all')
const query = ref('')
const source = ref('')
const hermes = ref<{ total: number; enabled: number } | null>(null)

const waitingTargets = computed(() => (overview.value?.targets || []).filter(target => target.waiting > 0))
const needsSync = computed(() => (overview.value?.items || []).filter(item => item.state === 'sync' || item.state === 'missing').length)
const updates = computed(() => (overview.value?.items || []).filter(item => item.state === 'update'))
const kinds = computed(() => (overview.value?.kinds || []).filter(entry => entry.total > 0))
const library = computed(() => {
  const q = query.value.trim().toLowerCase()
  return (overview.value?.items || []).filter(item => (kind.value === 'all' || item.kind === kind.value) && (!q || `${item.name} ${item.source}`.toLowerCase().includes(q)))
})
const headline = computed(() => {
  if (!overview.value) return ''
  if (waitingTargets.value.length) return t('commandCenter.skills.targetsWaiting', { n: waitingTargets.value.length })
  if (needsSync.value) return t('commandCenter.skills.toSync', { n: needsSync.value })
  return t('commandCenter.skills.inSync')
})

async function load() {
  loading.value = true
  try {
    overview.value = await fetchSkillshare()
    error.value = ''
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function loadHermes() {
  try {
    const data = await fetchSkills()
    const all = data.categories.flatMap(category => category.skills)
    hermes.value = { total: all.length, enabled: all.filter(skill => skill.enabled !== false).length }
  } catch { hermes.value = null }
}

function confirm(title: string, content: string, run: () => Promise<SkillshareResult>, key: string) {
  dialog.warning({
    title,
    content,
    positiveText: t('commandCenter.skills.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      busy.value = key
      try {
        const result = await run()
        if (result.ok) toast.success(result.message)
        else toast.error(result.message)
        await load()
      } catch (err: any) {
        toast.error(err?.message || String(err))
      } finally {
        busy.value = ''
      }
    },
  })
}

function sync() {
  const targets = waitingTargets.value.map(target => target.name).join(', ')
  confirm(t('commandCenter.skills.syncTitle'), targets ? t('commandCenter.skills.syncBody', { targets }) : t('commandCenter.skills.syncAll'), syncSkillshare, 'sync')
}
function update(item: SkillshareItem) {
  confirm(t('commandCenter.skills.updateTitle', { name: item.name }), t('commandCenter.skills.updateBody'), () => updateSkillshare({ kind: item.kind, name: item.name }), item.key)
}
function updateAll() {
  confirm(t('commandCenter.skills.updateAllTitle', { n: updates.value.length }), t('commandCenter.skills.updateBody'), async () => {
    const kinds = [...new Set(updates.value.map(item => item.kind))]
    let last: SkillshareResult = { ok: true, message: '' }
    for (const one of kinds) {
      last = await updateSkillshare({ kind: one, all: true })
      if (!last.ok) break
    }
    return last
  }, 'update-all')
}
function install() {
  const value = source.value.trim()
  if (!value) return
  confirm(t('commandCenter.skills.installTitle'), t('commandCenter.skills.installBody', { source: value }), async () => {
    const result = await installSkillshare(value)
    if (result.ok) source.value = ''
    return result
  }, 'install')
}
async function check() {
  busy.value = 'check'
  try { overview.value = await checkSkillshare() } catch (err: any) { toast.error(err?.message || String(err)) } finally { busy.value = '' }
}

const STATE_CLASS: Record<string, string> = { sync: 'is-warn', missing: 'is-warn', update: 'is-good', broken: 'is-bad' }

onMounted(() => { void load(); void loadHermes() })
</script>

<template>
  <section class="source cc-skills" data-testid="cc-skills">
    <p v-if="error" class="source-error">{{ error }}</p>
    <p v-else-if="!overview && loading" class="source-empty">{{ t('commandCenter.skills.reading') }}</p>
    <div v-else-if="overview && !overview.installed" class="cc-empty-state" data-testid="cc-skills-missing">
      <h4>{{ t('commandCenter.skills.missingTitle') }}</h4>
      <p>{{ t('commandCenter.skills.missingBody') }}</p>
      <pre class="cc-code">curl -fsSL https://raw.githubusercontent.com/runkids/skillshare/main/install.sh | sh
skillshare init</pre>
      <p>{{ t('commandCenter.skills.missingAfter') }}</p>
      <a class="source-link" href="https://github.com/runkids/skillshare" target="_blank" rel="noopener">github.com/runkids/skillshare</a>
    </div>
    <template v-else-if="overview">
      <div class="source-bar">
        <div class="cc-seg" role="radiogroup" :aria-label="t('commandCenter.tabs.skills')">
          <button type="button" role="radio" :aria-checked="view === 'overview'" :class="{ active: view === 'overview' }" @click="view = 'overview'">{{ t('commandCenter.skills.overview') }}</button>
          <button type="button" role="radio" :aria-checked="view === 'library'" :class="{ active: view === 'library' }" @click="view = 'library'">{{ t('commandCenter.skills.library', { n: overview.items.length }) }}</button>
        </div>
        <span class="source-spacer" />
        <NButton size="tiny" quaternary :loading="loading" @click="load">{{ t('mission.refresh') }}</NButton>
      </div>
      <p v-if="overview.error" class="source-error">{{ overview.error }}</p>

      <template v-if="view === 'overview'">
        <div class="source-card cc-headline" :class="waitingTargets.length || needsSync ? 'is-waiting' : 'is-ok'" data-theme-surface="card" data-testid="cc-skills-headline">
          <strong>{{ headline }}</strong>
          <span class="cc-sub">{{ t('commandCenter.skills.summary', { n: overview.items.length, targets: overview.targets.length }) }}</span>
          <div class="source-card-actions">
            <NButton size="tiny" type="primary" :loading="busy === 'sync'" data-testid="cc-skills-sync" @click="sync">{{ t('commandCenter.skills.sync') }}</NButton>
            <NButton size="tiny" :loading="busy === 'check'" @click="check">{{ t('commandCenter.skills.check') }}</NButton>
            <NButton v-if="updates.length" size="tiny" :loading="busy === 'update-all'" @click="updateAll">{{ t('commandCenter.skills.updateAll', { n: updates.length }) }}</NButton>
          </div>
        </div>
        <h5 class="cc-h">{{ t('commandCenter.skills.targets') }}</h5>
        <ul class="cc-targets">
          <li v-for="target in overview.targets" :key="target.name" :title="target.path">
            <span class="cc-dot" :class="target.waiting ? 'is-warn' : 'is-good'" aria-hidden="true" />
            <span class="cc-target-name">{{ target.name }}</span>
            <span class="source-spacer" />
            <span>{{ target.waiting ? t('commandCenter.skills.waiting', { n: target.waiting }) : t('commandCenter.skills.targetOk') }}</span>
          </li>
        </ul>
        <h5 class="cc-h">{{ t('commandCenter.skills.kinds') }}</h5>
        <table class="cc-kinds">
          <tbody>
            <tr v-for="entry in kinds" :key="entry.kind">
              <th scope="row">{{ t(`commandCenter.skills.kind.${entry.kind}`) }}</th>
              <td>{{ entry.total }}</td>
              <td :class="{ 'is-warn': entry.needsSync }">{{ t('commandCenter.skills.needsSync', { n: entry.needsSync }) }}</td>
              <td :class="{ 'is-good': entry.updates }">{{ overview.checked ? t('commandCenter.skills.updates', { n: entry.updates }) : '' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!overview.checked" class="cc-sub">{{ t('commandCenter.skills.notChecked') }}</p>
        <p class="cc-sub">{{ t('commandCenter.skills.source', { path: overview.source || '—', version: overview.version || '?' }) }}</p>
      </template>

      <template v-else>
        <div class="cc-seg cc-kinds-filter" role="radiogroup" :aria-label="t('commandCenter.skills.kinds')">
          <button type="button" role="radio" :aria-checked="kind === 'all'" :class="{ active: kind === 'all' }" @click="kind = 'all'">{{ t('commandCenter.skills.all') }}</button>
          <button v-for="entry in kinds" :key="entry.kind" type="button" role="radio" :aria-checked="kind === entry.kind" :class="{ active: kind === entry.kind }" @click="kind = entry.kind">{{ t(`commandCenter.skills.kind.${entry.kind}`) }}</button>
        </div>
        <NInput v-model:value="query" size="small" clearable :placeholder="t('commandCenter.skills.search')" />
        <ul class="cc-library">
          <li v-for="item in library" :key="item.key" class="cc-skill" data-testid="cc-skill-row">
            <div class="cc-skill-main">
              <span class="cc-skill-name">{{ item.name }}</span>
              <span class="cc-sub">{{ item.source }}{{ item.reason ? ` · ${item.reason}` : '' }}</span>
            </div>
            <span class="source-chip" :class="STATE_CLASS[item.state]">{{ t(`commandCenter.skills.state.${item.state}`) }}</span>
            <NButton v-if="item.state === 'update' && (item.kind === 'skills' || item.kind === 'agents')" size="tiny" :loading="busy === item.key" @click="update(item)">{{ t('commandCenter.skills.update') }}</NButton>
          </li>
        </ul>
        <p v-if="!library.length" class="source-empty">{{ t('commandCenter.skills.noMatch') }}</p>
        <div class="cc-install">
          <NInput v-model:value="source" size="small" :placeholder="t('commandCenter.skills.installPlaceholder')" @keydown.enter="install" />
          <NButton size="small" :disabled="!source.trim()" :loading="busy === 'install'" @click="install">{{ t('commandCenter.skills.install') }}</NButton>
        </div>
        <p class="cc-sub">{{ t('commandCenter.skills.installHint') }}</p>
      </template>
    </template>
    <footer class="cc-hermes">
      <span v-if="hermes">{{ t('commandCenter.skills.hermes', { n: hermes.total, enabled: hermes.enabled }) }}</span>
      <a class="source-link" href="#/hermes/skills">{{ t('commandCenter.skills.openHermes') }}</a>
    </footer>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '../sources/source';
@use './command-center';

.cc-headline {
  border-left-width: 3px;

  &.is-ok { border-left-color: $success; }
  &.is-waiting { border-left-color: $warning; }
}

.cc-sub {
  margin: 0;
  font-size: 11.5px;
  color: $text-muted;
  word-break: break-word;
}

.cc-h {
  margin: 4px 0 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: $text-muted;
}

.cc-targets,
.cc-library {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cc-targets li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 12.5px;
}

.cc-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: $success;

  &.is-warn { background: $warning; }
}

.cc-kinds {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  th {
    text-align: left;
    font-weight: 500;
  }

  td {
    color: $text-muted;
    text-align: right;
    padding: 2px 0 2px 8px;
  }

  .is-warn { color: $warning; }
  .is-good { color: $success; }
}

.cc-skill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 0;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.cc-skill-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.cc-skill-name {
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-install {
  display: flex;
  gap: 6px;
}

.cc-empty-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: $text-secondary;

  h4 {
    margin: 0;
    color: $text-primary;
  }

  p {
    margin: 0;
  }
}

.cc-code {
  margin: 0;
  padding: 8px;
  overflow-x: auto;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 6px;
  font-family: $font-code;
  font-size: 11px;
  white-space: pre;
}

.cc-hermes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: auto;
  padding-top: 6px;
  border-top: var(--border-width, 1px) solid $border-light;
  font-size: 11.5px;
  color: $text-muted;
}
</style>
