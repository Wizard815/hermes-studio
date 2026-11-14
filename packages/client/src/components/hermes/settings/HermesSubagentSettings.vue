<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SettingRow from './SettingRow.vue'
import {
  getDelegationRouting, routeDefault, saveModelRoutes, saveProfileRoutes, setDelegationBackend,
  type DelegationRouting, type ModelRoute, type ProfileRoute,
} from '@/api/hermes/agent-tools'

const { t } = useI18n()
const message = useMessage()

const loading = ref(true)
const loadError = ref('')
const routing = ref<DelegationRouting | null>(null)
const modelRoutes = ref<ModelRoute[]>([])
const modelDefault = ref<string | null>(null)
const profileRoutes = ref<ProfileRoute[]>([])
const profileDefault = ref<string | null>(null)
const savingModels = ref(false)
const savingProfiles = ref(false)

const backendOptions = computed(() => (routing.value?.backends || []).map(b => ({
  label: b.available ? b.label : `${b.label} (${t('hermesTools.subagents.notAvailable')})`,
  value: b.name,
  disabled: !b.available && !b.builtin,
})))
const currentBackend = computed(() => routing.value?.backends.find(b => b.name === routing.value?.configured))
const hasModelMap = computed(() => !!routing.value?.backends.some(b => b.name === 'model_map'))
const hasProfileRoutes = computed(() => !!routing.value?.backends.some(b => b.name === 'profile_routes'))

function apply(data: DelegationRouting) {
  routing.value = data
  modelRoutes.value = data.model_map.options.map(o => ({ ...o, original_name: o.name }))
  modelDefault.value = data.model_map.default
  profileRoutes.value = data.profile_routes.profiles.map(p => ({ ...p }))
  profileDefault.value = data.profile_routes.default
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    apply(await getDelegationRouting())
  } catch (err: any) {
    loadError.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function chooseBackend(name: string) {
  try {
    await setDelegationBackend(name)
    message.success(t('settings.saved'))
    apply(await getDelegationRouting())
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  }
}

function addModelRoute() {
  modelRoutes.value.push({ name: '', description: '', provider: '', model: '' })
}
function addProfileRoute() {
  profileRoutes.value.push({ name: '', description: '' })
}

async function saveModels() {
  savingModels.value = true
  try {
    const names = modelRoutes.value.map(r => r.name.trim())
    await saveModelRoutes(modelRoutes.value, routeDefault(names, modelDefault.value))
    message.success(t('settings.saved'))
    apply(await getDelegationRouting())
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    savingModels.value = false
  }
}

async function saveProfiles() {
  savingProfiles.value = true
  try {
    const names = profileRoutes.value.map(r => r.name)
    await saveProfileRoutes(profileRoutes.value, routeDefault(names, profileDefault.value))
    message.success(t('settings.saved'))
    apply(await getDelegationRouting())
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    savingProfiles.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="settings-section">
    <div class="section-head">
      <div>
        <h3 class="section-title">{{ t('hermesTools.subagents.title') }}</h3>
        <p class="section-hint">{{ t('hermesTools.subagents.hint') }}</p>
      </div>
      <NButton size="small" :loading="loading" @click="load">{{ t('hermesTools.common.refresh') }}</NButton>
    </div>
    <NSpin :show="loading && !routing">
      <p v-if="loadError" class="muted">{{ t('hermesTools.common.unavailable') }} {{ loadError }}</p>
      <template v-else-if="routing">
        <SettingRow :label="t('hermesTools.subagents.backend')" :hint="currentBackend?.description || ''">
          <NSelect class="input-md" size="small" :value="routing.configured" :options="backendOptions" @update:value="chooseBackend" />
        </SettingRow>
        <NAlert v-if="routing.blocked_reason" type="warning" :show-icon="false" class="blocked">
          {{ t('hermesTools.subagents.blocked') }} {{ routing.blocked_reason }}
        </NAlert>
        <p v-if="routing.backends.length <= 1" class="muted">{{ t('hermesTools.subagents.onlyDefault') }}</p>
      </template>
    </NSpin>
  </section>

  <section v-if="routing && (hasModelMap || modelRoutes.length)" class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.subagents.modelRoutes') }}</h3>
    <p class="section-hint">{{ t('hermesTools.subagents.modelRoutesHint') }}</p>
    <div v-for="(route, index) in modelRoutes" :key="index" class="route-card">
      <div class="route-grid">
        <NInput v-model:value="route.name" size="small" :placeholder="t('hermesTools.subagents.routeName')" />
        <NInput v-model:value="route.provider" size="small" :placeholder="t('hermesTools.subagents.provider')" />
        <NInput v-model:value="route.model" size="small" :placeholder="t('hermesTools.subagents.model')" />
        <NInput v-model:value="route.base_url" size="small" :placeholder="t('hermesTools.subagents.baseUrl')" />
      </div>
      <NInput v-model:value="route.description" size="small" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" :placeholder="t('hermesTools.subagents.whenToUse')" />
      <div class="row-actions route-foot">
        <NTag v-if="modelDefault && modelDefault === route.name" size="small" type="success" :bordered="false">{{ t('hermesTools.subagents.default') }}</NTag>
        <NButton v-else size="tiny" quaternary :disabled="!route.name" @click="modelDefault = route.name">{{ t('hermesTools.subagents.makeDefault') }}</NButton>
        <NButton size="tiny" quaternary type="error" @click="modelRoutes.splice(index, 1)">{{ t('hermesTools.common.remove') }}</NButton>
      </div>
    </div>
    <div class="row-actions save-row">
      <NButton size="small" @click="addModelRoute">{{ t('hermesTools.subagents.addRoute') }}</NButton>
      <NButton size="small" type="primary" :loading="savingModels" @click="saveModels">{{ t('hermesTools.common.save') }}</NButton>
    </div>
  </section>

  <section v-if="routing && (hasProfileRoutes || profileRoutes.length)" class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.subagents.profileRoutes') }}</h3>
    <p class="section-hint">{{ t('hermesTools.subagents.profileRoutesHint') }}</p>
    <div v-for="(route, index) in profileRoutes" :key="index" class="route-card">
      <div class="route-grid">
        <NSelect v-model:value="route.name" size="small" :options="routing.profiles.map(p => ({ label: p, value: p }))" :placeholder="t('hermesTools.subagents.profile')" />
        <NInput v-model:value="route.description" size="small" :placeholder="t('hermesTools.subagents.whenToUse')" />
      </div>
      <div class="row-actions route-foot">
        <NTag v-if="profileDefault && profileDefault === route.name" size="small" type="success" :bordered="false">{{ t('hermesTools.subagents.default') }}</NTag>
        <NButton v-else size="tiny" quaternary :disabled="!route.name" @click="profileDefault = route.name">{{ t('hermesTools.subagents.makeDefault') }}</NButton>
        <NButton size="tiny" quaternary type="error" @click="profileRoutes.splice(index, 1)">{{ t('hermesTools.common.remove') }}</NButton>
      </div>
    </div>
    <div class="row-actions save-row">
      <NButton size="small" @click="addProfileRoute">{{ t('hermesTools.subagents.addProfile') }}</NButton>
      <NButton size="small" type="primary" :loading="savingProfiles" @click="saveProfiles">{{ t('hermesTools.common.save') }}</NButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use './hermes-tools' as *;
@use '@/styles/variables' as vars;

.blocked {
  margin-top: 8px;
}

.route-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: var(--border-width, 1px) solid vars.$border-light;
  border-radius: vars.$radius-sm;
}

.route-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
}

.route-foot {
  justify-content: flex-end;
}

.save-row {
  justify-content: flex-end;
  padding-top: 4px;
}
</style>
