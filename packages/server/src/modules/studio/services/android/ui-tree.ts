// The screen as text for agents: `uiautomator dump` XML cut down to the
// elements a person could see or use, each with a short id the agent taps by.
// Idea from the phone-harness Hermes plugin (MIT); written for Studio's adb layer.

export interface UiElement {
  /** e1, e2, ... in screen order; valid until the next dump of that device. */
  id: string
  cls: string
  text: string
  desc: string
  resourceId: string
  pkg: string
  clickable: boolean
  editable: boolean
  scrollable: boolean
  checked: boolean | null
  focused: boolean
  /** Pixel bounds [left, top, right, bottom]. */
  bounds: [number, number, number, number]
  /** Center in pixels, where a tap lands. */
  x: number
  y: number
}

const NODE = /<node\b([^>]*?)\/?>/g
const ATTR = /([\w-]+)="([^"]*)"/g
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

function unescape(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/** Elements worth showing: they say something or can be used, and have a size on screen. */
export function parseUiDump(xml: string): UiElement[] {
  const out: UiElement[] = []
  for (const match of xml.matchAll(NODE)) {
    const attrs: Record<string, string> = {}
    for (const [, key, value] of match[1].matchAll(ATTR)) attrs[key] = unescape(value)
    const box = BOUNDS.exec(attrs.bounds || '')
    if (!box) continue
    const bounds = box.slice(1).map(Number) as [number, number, number, number]
    if (bounds[2] - bounds[0] <= 1 || bounds[3] - bounds[1] <= 1) continue
    const text = (attrs.text || '').trim()
    const desc = (attrs['content-desc'] || '').trim()
    const cls = (attrs.class || '').split('.').pop() || ''
    const clickable = attrs.clickable === 'true' || attrs['long-clickable'] === 'true'
    const editable = /EditText|AutoCompleteTextView/.test(attrs.class || '')
    const scrollable = attrs.scrollable === 'true'
    const checkable = attrs.checkable === 'true'
    if (!text && !desc && !clickable && !editable && !scrollable && !checkable) continue
    out.push({
      id: `e${out.length + 1}`,
      cls,
      text,
      desc,
      resourceId: (attrs['resource-id'] || '').replace(/^[\w.]+:id\//, ''),
      pkg: attrs.package || '',
      clickable,
      editable,
      scrollable,
      checked: checkable ? attrs.checked === 'true' : null,
      focused: attrs.focused === 'true',
      bounds,
      x: Math.round((bounds[0] + bounds[2]) / 2),
      y: Math.round((bounds[1] + bounds[3]) / 2),
    })
  }
  return out
}

const clip = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** One line per element: `[e3] Button "Send" #send_btn (540,1820) tap`. Short, so it costs few tokens. */
export function compactUiTree(elements: UiElement[], maxLines = 150): string {
  const lines = elements.slice(0, maxLines).map(el => {
    const label = el.text || el.desc
    const flags = [
      el.clickable ? 'tap' : '',
      el.editable ? 'type' : '',
      el.scrollable ? 'scroll' : '',
      el.checked === true ? 'on' : el.checked === false ? 'off' : '',
      el.focused ? 'focused' : '',
    ].filter(Boolean).join(' ')
    return [
      `[${el.id}]`,
      el.cls,
      label ? JSON.stringify(clip(label)) : '',
      el.text && el.desc && el.desc !== el.text ? `(${clip(el.desc, 40)})` : '',
      el.resourceId ? `#${el.resourceId}` : '',
      `(${el.x},${el.y})`,
      flags,
    ].filter(Boolean).join(' ')
  })
  if (elements.length > maxLines) lines.push(`… ${elements.length - maxLines} more elements; scroll or read a screenshot.`)
  return lines.join('\n')
}

/** The app in front: the package most elements belong to. */
export function foregroundPackage(elements: UiElement[]): string {
  const counts = new Map<string, number>()
  for (const el of elements) if (el.pkg && el.pkg !== 'com.android.systemui') counts.set(el.pkg, (counts.get(el.pkg) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
}
