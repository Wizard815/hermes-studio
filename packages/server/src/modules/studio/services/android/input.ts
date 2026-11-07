// Gestures from the Studio panel, turned into `adb shell input ...` argument lists.
// Coordinates arrive as 0..1 fractions of the frame the viewer sees, so the
// panel never needs to know the device's resolution or rotation.
// Adapted from herdr-sim's AdbInput (MIT, Copyright (c) 2026 Robert Soriano).

export interface ScreenSize { width: number; height: number }

export type AndroidKey =
  | 'home' | 'back' | 'recents' | 'power' | 'volume_up' | 'volume_down'
  | 'enter' | 'backspace' | 'delete' | 'tab' | 'escape' | 'space'
  | 'up' | 'down' | 'left' | 'right' | 'menu'

export type AndroidGesture =
  | { type: 'tap'; x: number; y: number }
  | { type: 'longpress'; x: number; y: number; ms?: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { type: 'key'; key: AndroidKey }
  | { type: 'text'; text: string }
  | { type: 'rotate' }

export const KEYCODES: Record<AndroidKey, number> = {
  home: 3, back: 4, recents: 187, power: 26, volume_up: 24, volume_down: 25,
  enter: 66, backspace: 67, delete: 112, tab: 61, escape: 111, space: 62,
  up: 19, down: 20, left: 21, right: 22, menu: 82,
}

const MAX_TEXT = 500

const clamp01 = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN
}

/**
 * The device's size in its current rotation. `wm size` always reports the
 * natural (usually portrait) size; a landscape frame means it is turned.
 */
export function orientedSize(natural: ScreenSize, frame?: ScreenSize | null): ScreenSize {
  if (!frame) return natural
  const frameLandscape = frame.width > frame.height
  const naturalLandscape = natural.width > natural.height
  return frameLandscape === naturalLandscape ? natural : { width: natural.height, height: natural.width }
}

function px(size: ScreenSize, x: number, y: number): [string, string] {
  return [String(Math.round(x * (size.width - 1))), String(Math.round(y * (size.height - 1)))]
}

function duration(ms: unknown, fallback: number): string {
  const n = Math.round(Number(ms))
  return String(Number.isFinite(n) ? Math.min(5000, Math.max(1, n)) : fallback)
}

/**
 * Quotes text for `input text`. adb joins shell arguments into one command line
 * that the device's sh parses, so the text goes in single quotes; `input text`
 * itself reads `%s` as a space.
 */
export function quoteInputText(text: string): string {
  const safe = text.replace(/[\r\n]+/g, ' ').replace(/%/g, '\\%').replace(/ /g, '%s')
  return `'${safe.replace(/'/g, `'\\''`)}'`
}

/** The `adb shell` arguments for a gesture, or null when the gesture is malformed. */
export function gestureArgs(gesture: AndroidGesture, size: ScreenSize): string[] | null {
  switch (gesture?.type) {
    case 'tap': {
      const x = clamp01(gesture.x), y = clamp01(gesture.y)
      return Number.isNaN(x) || Number.isNaN(y) ? null : ['input', 'tap', ...px(size, x, y)]
    }
    case 'longpress': {
      const x = clamp01(gesture.x), y = clamp01(gesture.y)
      if (Number.isNaN(x) || Number.isNaN(y)) return null
      const at = px(size, x, y)
      return ['input', 'swipe', ...at, ...at, duration(gesture.ms, 600)]
    }
    case 'swipe': {
      const points = [gesture.x1, gesture.y1, gesture.x2, gesture.y2].map(clamp01)
      if (points.some(Number.isNaN)) return null
      return ['input', 'swipe', ...px(size, points[0], points[1]), ...px(size, points[2], points[3]), duration(gesture.ms, 200)]
    }
    case 'key': {
      const code = KEYCODES[gesture.key]
      return code == null ? null : ['input', 'keyevent', String(code)]
    }
    case 'text': {
      const text = String(gesture.text ?? '').slice(0, MAX_TEXT)
      return text ? ['input', 'text', quoteInputText(text)] : null
    }
    case 'rotate':
      // One string: adb hands it to the device's sh as is.
      return ['settings put system accelerometer_rotation 0; r=$(settings get system user_rotation); settings put system user_rotation $(( (${r:-0} + 1) % 4 ))']
    default:
      return null
  }
}
