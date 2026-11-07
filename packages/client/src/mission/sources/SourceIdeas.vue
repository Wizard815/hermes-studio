<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchOrbData } from '@/api/studio/orb'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import LaunchButtons from '../LaunchButtons.vue'

/** Pondering Orb idea-board cards, by stage (thought, design, code). */
interface IdeaCard { id: string; type?: string; title?: string; text?: string; stage?: string; url?: string }

const props = defineProps<{ panes: HerdrPaneView[]; workspace: string }>()
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const cards = ref<IdeaCard[]>([])
const error = ref('')
const STAGES = ['thought', 'design', 'code'] as const

const stages = computed(() => STAGES.map(stage => ({
  stage,
  items: cards.value.filter(card => ['idea', 'note', 'todo'].includes(card.type || 'note')
    && (card.title || card.text) && (card.stage || 'thought') === stage),
})))

async function load() {
  try {
    cards.value = await fetchOrbData<IdeaCard[]>('ideas')
    error.value = ''
  } catch (err: any) {
    error.value = err?.message || String(err)
  }
}

function promptFor(card: IdeaCard): string {
  return [`An idea from my Pondering Orb board (${card.stage || 'thought'} stage): ${card.title || ''}`, card.text || '', 'Turn it into a short plan first, then build it.'].filter(Boolean).join('\n')
}

onMounted(load)
</script>

<template>
  <section class="source" data-testid="mission-source-ideas">
    <div class="source-bar">
      <span>{{ t('mission.ideasHint') }}</span>
      <span class="source-spacer" />
      <button type="button" class="source-link" @click="load">{{ t('mission.refresh') }}</button>
    </div>
    <p v-if="error" class="source-error">{{ error }}</p>
    <div class="source-groups">
      <div v-for="column in stages" :key="column.stage" class="source-group">
        <h4>{{ t(`mission.stage.${column.stage}`) }} <span>{{ column.items.length }}</span></h4>
        <article v-for="card in column.items" :key="card.id" class="source-card" data-theme-surface="card">
          <span class="source-card-title">{{ card.title || card.text }}</span>
          <span v-if="card.title && card.text" class="source-card-meta">{{ card.text }}</span>
          <div class="source-card-actions">
            <LaunchButtons
              :card-key="`idea:${card.id}`"
              :title="card.title || t('mission.idea')"
              :prompt="promptFor(card)"
              :workspace="props.workspace || undefined"
              :panes="props.panes"
              @launched="pane => emit('select-pane', pane)"
            />
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use './source';
</style>
