<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PinComment from '@/components/common/PinComment.vue'
import { imageName, pinCommentTarget } from '@/utils/pin-comment'

const props = defineProps<{
  src: string
  alt: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
// Comment mode: clicks pin comments on the image instead of closing it (utils/pin-comment.ts).
const commenting = ref(false)
const status = ref('')
const canComment = computed(() => !!pinCommentTarget.value)
const name = computed(() => imageName(props.src, props.alt))

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

function onImageClick() {
  if (!commenting.value) emit('close')
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      class="image-preview-overlay"
      :class="{ 'image-preview-overlay--commenting': commenting }"
      role="dialog"
      aria-modal="true"
      :aria-label="alt"
      @click.self="emit('close')"
    >
      <div v-if="canComment" class="image-preview-toolbar" @click.stop>
        <button
          type="button"
          class="image-preview-tool"
          :class="{ active: commenting }"
          :aria-pressed="commenting"
          data-testid="image-preview-comment"
          @click="commenting = !commenting"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {{ commenting ? t('pinComment.commenting') : t('pinComment.comment') }}
        </button>
        <button type="button" class="image-preview-tool" :aria-label="t('pinComment.close')" @click="emit('close')">✕</button>
        <span class="image-preview-status" role="status" aria-live="polite">{{ status }}</span>
      </div>
      <PinComment :name="name" :active="commenting" @sent="status = t('pinComment.sent')" @error="message => status = message">
        <img :src="src" :alt="alt" class="image-preview-img" @click="onImageClick" />
      </PinComment>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5vh 5vw;
  background: rgba(0, 0, 0, 0.85);
  cursor: zoom-out;

  &--commenting { cursor: default; }
}

.image-preview-img {
  display: block;
  max-width: 90vw;
  max-height: 86vh;
  object-fit: contain;
  border-radius: var(--radius-component, 6px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.image-preview-toolbar {
  position: absolute;
  top: 12px;
  inset-inline-end: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: auto;
}

.image-preview-tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 12px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  background-color: var(--theme-content-bg, $bg-main-surface);
  color: $text-primary;
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  &.active { border-color: $accent-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.image-preview-status {
  order: -1;
  font-size: 12px;
  color: var(--theme-content-bg, $bg-main-surface);
}
</style>
