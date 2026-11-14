<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NEmpty, NForm, NFormItem, NInput, NModal, NSelect, NSpin, NTag, NTimePicker, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  WEEKDAY_CHOICES, blueprintDefaults, blueprintValues, instantiateBlueprint, listBlueprints, missingBlueprintField,
  type Blueprint, type BlueprintField,
} from '@/api/hermes/agent-tools'

const emit = defineEmits<{ close: []; saved: [] }>()
const { t, te } = useI18n()
const message = useMessage()

const show = ref(true)
const loading = ref(true)
const loadError = ref('')
const blueprints = ref<Blueprint[]>([])
const selected = ref<Blueprint | null>(null)
const values = ref<Record<string, any>>({})
const creating = ref(false)
const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return blueprints.value
  return blueprints.value.filter(b => [b.title, b.description, b.category, ...(b.tags || [])].join(' ').toLowerCase().includes(q))
})

async function load() {
  loading.value = true
  try {
    blueprints.value = (await listBlueprints()).blueprints || []
  } catch (err: any) {
    loadError.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

function pick(blueprint: Blueprint) {
  selected.value = blueprint
  values.value = blueprintDefaults(blueprint)
}

function options(field: BlueprintField) {
  const list = field.options?.length ? field.options : field.type === 'weekdays' ? WEEKDAY_CHOICES : []
  return list.map(value => ({ label: te(`hermesTools.templates.choices.${value}`) ? t(`hermesTools.templates.choices.${value}`) : value, value }))
}

async function create() {
  if (!selected.value) return
  const missing = missingBlueprintField(selected.value, values.value)
  if (missing) {
    message.warning(t('hermesTools.templates.fillIn', { field: missing.label }))
    return
  }
  creating.value = true
  try {
    await instantiateBlueprint(selected.value.key, blueprintValues(selected.value, values.value))
    message.success(t('hermesTools.templates.created'))
    emit('saved')
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    creating.value = false
  }
}

function close() {
  show.value = false
  emit('close')
}

onMounted(load)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="selected ? selected.title : t('hermesTools.templates.title')"
    style="width: min(640px, calc(100vw - 32px))"
    :bordered="false"
    @update:show="(v: boolean) => { if (!v) close() }"
  >
    <NSpin :show="loading">
      <template v-if="!selected">
        <p class="hint">{{ t('hermesTools.templates.hint') }}</p>
        <NInput v-model:value="search" size="small" clearable :placeholder="t('hermesTools.templates.search')" class="search" />
        <p v-if="loadError" class="hint">{{ t('hermesTools.common.unavailable') }} {{ loadError }}</p>
        <NEmpty v-else-if="!loading && !filtered.length" :description="t('hermesTools.templates.empty')" />
        <div class="template-list">
          <button v-for="bp in filtered" :key="bp.key" type="button" class="template-card" data-testid="job-template" @click="pick(bp)">
            <span class="template-title">{{ bp.title }}</span>
            <span class="hint">{{ bp.description }}</span>
            <span class="template-meta">
              <NTag v-if="bp.category" size="tiny" :bordered="false">{{ bp.category }}</NTag>
              <span v-if="bp.scheduleHuman" class="hint">{{ bp.scheduleHuman }}</span>
            </span>
          </button>
        </div>
      </template>

      <template v-else>
        <p class="hint">{{ selected.description }}</p>
        <NForm label-placement="top" size="small">
          <NFormItem v-for="field in selected.fields" :key="field.name" :label="field.label + (field.optional ? ` (${t('hermesTools.templates.optional')})` : '')">
            <div class="field">
              <NTimePicker
                v-if="field.type === 'time'"
                :formatted-value="values[field.name] || null"
                value-format="HH:mm"
                format="HH:mm"
                @update:formatted-value="(v: string | null) => (values[field.name] = v || '')"
              />
              <NSelect
                v-else-if="field.type === 'enum' || field.type === 'weekdays'"
                v-model:value="values[field.name]"
                :options="options(field)"
                :tag="!field.strict"
                filterable
              />
              <NInput v-else v-model:value="values[field.name]" type="textarea" :autosize="{ minRows: 1, maxRows: 6 }" />
              <span v-if="field.help" class="hint">{{ field.help }}</span>
            </div>
          </NFormItem>
        </NForm>
      </template>
    </NSpin>

    <template #footer>
      <div class="footer">
        <NButton v-if="selected" size="small" @click="selected = null">{{ t('hermesTools.templates.back') }}</NButton>
        <span class="spacer" />
        <NButton size="small" @click="close">{{ t('hermesTools.common.cancel') }}</NButton>
        <NButton v-if="selected" size="small" type="primary" :loading="creating" @click="create">{{ t('hermesTools.templates.create') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hint {
  margin: 0 0 8px;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.search {
  margin-bottom: 10px;
}

.template-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 60vh;
  overflow-y: auto;
}

.template-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  text-align: start;
  background: transparent;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
  color: inherit;
  cursor: pointer;
  transition: border-color $transition-fast;

  &:hover {
    border-color: $accent-primary;
  }

  .hint {
    margin: 0;
  }
}

.template-title {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 600;
  color: $text-primary;
}

.template-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}
</style>
