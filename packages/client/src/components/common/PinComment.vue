<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { pinCommentTarget, pinCommentText, pinPercent } from '@/utils/pin-comment'

// Wraps a screenshot or the browser view. While `active`, a click pins a spot
// and opens "Comment on this spot…"; Send posts
// "Comment on <name> (pinned at x% from the left, y% from the top): text" to the
// open chat. Sent pins stay as numbered marks.
const props = defineProps<{ name: string; active: boolean }>()
const emit = defineEmits<{ sent: [text: string]; error: [message: string] }>()
const { t } = useI18n()

const layer = ref<HTMLElement | null>(null)
const pending = ref<{ x: number; y: number } | null>(null)
const draft = ref('')
const sending = ref(false)
const pins = ref<Array<{ x: number; y: number; text: string }>>([])
const input = ref<InstanceType<typeof NInput> | null>(null)

const popoverStyle = computed(() => {
  const spot = pending.value
  if (!spot) return {}
  return {
    [spot.x > 60 ? 'right' : 'left']: `${spot.x > 60 ? 100 - spot.x : spot.x}%`,
    [spot.y > 65 ? 'bottom' : 'top']: `${spot.y > 65 ? 100 - spot.y : spot.y}%`,
  }
})

function place(event: MouseEvent) {
  if (!props.active || !layer.value || sending.value) return
  const box = layer.value.getBoundingClientRect()
  pending.value = { x: pinPercent(event.clientX - box.left, box.width), y: pinPercent(event.clientY - box.top, box.height) }
  draft.value = ''
  void nextTick(() => input.value?.focus())
}

function cancel() {
  pending.value = null
  draft.value = ''
}

async function send() {
  const spot = pending.value
  const send = pinCommentTarget.value
  if (!spot || !draft.value.trim() || !send) return
  const text = pinCommentText(props.name, spot.x, spot.y, draft.value)
  sending.value = true
  try {
    await send(text)
    pins.value.push({ ...spot, text: draft.value.trim() })
    emit('sent', text)
    cancel()
  } catch (err: any) {
    emit('error', t('pinComment.failed', { error: err?.message || String(err) }))
  } finally {
    sending.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); cancel() }
  else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send() }
}

watch(() => props.active, active => { if (!active) cancel() })
watch(() => props.name, () => { pins.value = []; cancel() })
</script>

<template>
  <div class="pin-comment" :class="{ 'pin-comment--active': active }">
    <slot />
    <div
      v-if="active || pins.length"
      ref="layer"
      class="pin-comment-layer"
      :class="{ 'pin-comment-layer--passive': !active }"
      data-testid="pin-comment-layer"
      @click.stop="place"
    >
      <span
        v-for="(pin, index) in pins"
        :key="index"
        class="pin-comment-mark pin-comment-mark--sent"
        :style="{ left: `${pin.x}%`, top: `${pin.y}%` }"
        :title="pin.text"
        :aria-label="t('pinComment.pin', { n: index + 1 })"
      >{{ index + 1 }}</span>
      <span v-if="pending" class="pin-comment-mark" :style="{ left: `${pending.x}%`, top: `${pending.y}%` }" aria-hidden="true">{{ pins.length + 1 }}</span>
      <form
        v-if="pending"
        class="pin-comment-popover"
        :style="popoverStyle"
        role="dialog"
        :aria-label="t('pinComment.placeholder')"
        data-testid="pin-comment-popover"
        @click.stop
        @keydown.stop
        @submit.prevent="send"
      >
        <NInput
          ref="input"
          v-model:value="draft"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :placeholder="t('pinComment.placeholder')"
          :input-props="{ 'aria-label': t('pinComment.placeholder') }"
          :disabled="sending"
          data-testid="pin-comment-input"
          @keydown="onKeydown"
        />
        <div class="pin-comment-actions">
          <NButton size="small" quaternary @click="cancel">{{ t('pinComment.cancel') }}</NButton>
          <NButton size="small" type="primary" attr-type="submit" :loading="sending" :disabled="!draft.trim()" data-testid="pin-comment-send">{{ t('pinComment.send') }}</NButton>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.pin-comment {
  position: relative;
  display: inline-block;
  max-width: 100%;
  max-height: 100%;
  line-height: 0;
}
.pin-comment-layer {
  position: absolute;
  inset: 0;
  line-height: normal;
  cursor: crosshair;

  &--passive { pointer-events: none; cursor: inherit; }
}
.pin-comment-mark {
  position: absolute;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -12px 0 0 -12px;
  border: 2px solid var(--theme-content-bg, $bg-main-surface);
  border-radius: 50% 50% 50% 0;
  background-color: $accent-primary;
  color: var(--theme-content-bg, $bg-main-surface);
  font-size: 11px;
  font-weight: 600;
  box-shadow: var(--theme-card-shadow, none);
  pointer-events: auto;

  &--sent { opacity: 0.85; }
}
.pin-comment-popover {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(300px, 80vw);
  margin: 16px;
  padding: 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
  background-color: var(--theme-content-bg, $bg-main-surface);
  box-shadow: var(--theme-card-shadow, none);
  cursor: auto;
}
.pin-comment-actions { display: flex; justify-content: flex-end; gap: 6px; }
</style>
