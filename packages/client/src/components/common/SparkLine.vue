<script setup lang="ts">
import { computed, ref } from 'vue'

/** A single-series line over recent samples, with a hover readout. */
const props = withDefaults(defineProps<{
  values: number[]
  /** Fixed top of the scale (e.g. 100 for percentages); otherwise the largest sample. */
  max?: number
  label: string
  format?: (value: number) => string
  /** Seconds between samples, for the "n s ago" readout. */
  intervalSeconds?: number
}>(), { max: undefined, format: (value: number) => String(value), intervalSeconds: 2 })

const WIDTH = 240
const HEIGHT = 48
const hover = ref<number | null>(null)

// A fixed scale (percentages) as given; an open one gets headroom so a steady value is not drawn on the top edge.
const top = computed(() => props.max ?? Math.max(...props.values, 1) * 1.25)
const step = computed(() => WIDTH / Math.max(1, props.values.length - 1))
const points = computed(() => props.values
  .map((value, i) => `${(i * step.value).toFixed(1)},${(HEIGHT - 1 - (value / top.value) * (HEIGHT - 2)).toFixed(1)}`)
  .join(' '))
const hoverX = computed(() => hover.value == null ? 0 : hover.value * step.value)
const readout = computed(() => {
  if (hover.value == null) return ''
  const ago = (props.values.length - 1 - hover.value) * props.intervalSeconds
  return `${props.format(props.values[hover.value])}${ago ? ` · −${ago}s` : ''}`
})

function onMove(event: PointerEvent) {
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * WIDTH
  hover.value = Math.min(props.values.length - 1, Math.max(0, Math.round(x / step.value)))
}
</script>

<template>
  <div class="spark-line">
    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="label"
      @pointermove="onMove"
      @pointerleave="hover = null"
    >
      <line class="spark-line-base" x1="0" :y1="HEIGHT - 0.5" :x2="WIDTH" :y2="HEIGHT - 0.5" />
      <polyline v-if="values.length > 1" class="spark-line-path" :points="points" vector-effect="non-scaling-stroke" />
      <line v-if="hover != null" class="spark-line-cursor" :x1="hoverX" y1="0" :x2="hoverX" :y2="HEIGHT" vector-effect="non-scaling-stroke" />
    </svg>
    <span v-if="hover != null" class="spark-line-readout">{{ readout }}</span>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.spark-line {
  position: relative;
  width: 100%;

  svg {
    display: block;
    width: 100%;
    height: 48px;
    overflow: visible;
    touch-action: none;
  }
}

.spark-line-path {
  fill: none;
  stroke: $accent-primary;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.spark-line-base {
  stroke: $border-light;
  stroke-width: 1;
}

.spark-line-cursor {
  stroke: $text-muted;
  stroke-width: 1;
}

.spark-line-readout {
  position: absolute;
  top: -4px;
  right: 0;
  font-size: 11px;
  color: $text-secondary;
  font-variant-numeric: tabular-nums;
}
</style>
