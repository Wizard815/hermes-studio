/** Browser pointer and key input for an Android screen, as the gestures `/android` accepts. */

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

/** Turns a pointer press on the screen (fractions of the frame) into a gesture. */
export function pointerGesture(start: { x: number; y: number; t: number }, end: { x: number; y: number; t: number }): AndroidGesture {
  const ms = Math.max(1, end.t - start.t)
  const moved = Math.hypot(end.x - start.x, end.y - start.y)
  if (moved < 0.02) return ms >= 500 ? { type: 'longpress', x: start.x, y: start.y, ms } : { type: 'tap', x: start.x, y: start.y }
  return { type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, ms: Math.min(2000, Math.max(80, ms)) }
}

const KEY_MAP: Record<string, AndroidKey> = {
  Enter: 'enter', Backspace: 'backspace', Delete: 'delete', Tab: 'tab', Escape: 'escape',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
}

/** A browser key event as device input: a named key, typed text, or nothing. */
export function keyboardInput(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): { key: AndroidKey } | { text: string } | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const key = KEY_MAP[event.key]
  if (key) return { key }
  return event.key.length === 1 ? { text: event.key } : null
}
