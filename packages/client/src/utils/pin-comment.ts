import { shallowRef } from 'vue'

/**
 * Pin comments: click a spot on a screenshot or the browser view, write a
 * comment, and it goes to the open chat as
 * "Comment on <name> (pinned at 9% from the left, 25% from the top): <text>".
 * The chat that can take them registers itself as the target; with no target
 * the Comment buttons don't show.
 */
export type PinCommentSend = (text: string, attachments: PinAttachment[]) => Promise<unknown> | unknown

/** A picture sent with a comment; `context` is read by the model and shown collapsed. */
export interface PinAttachment { file: File; context?: string }

export const pinCommentTarget = shallowRef<PinCommentSend | null>(null)

export function setPinCommentTarget(send: PinCommentSend | null): void {
  pinCommentTarget.value = send
}

/** A whole percentage from 0 to 100. */
export function pinPercent(offset: number, size: number): number {
  if (!size || !Number.isFinite(offset)) return 0
  return Math.min(100, Math.max(0, Math.round((offset / size) * 100)))
}

export function pinCommentText(name: string, x: number, y: number, text: string): string {
  const label = name.trim() || 'this image'
  return `Comment on ${label} (pinned at ${x}% from the left, ${y}% from the top): ${text.trim()}`
}

/** A readable name for an image: its file name, else its alt text. */
export function imageName(src: string, alt = ''): string {
  if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
    try {
      // Studio serves files as /api/studio/files/download?path=<file>.
      const url = new URL(src, 'http://x')
      for (const path of [url.searchParams.get('path') || '', url.pathname]) {
        const last = decodeURIComponent(path.split('/').filter(Boolean).at(-1) || '')
        if (/\.[a-z0-9]{2,5}$/i.test(last)) return last
      }
    } catch { /* not a URL */ }
  }
  return alt.trim() || 'this image'
}

/** "upper left", "middle", "lower right"… for a spot given in whole percentages. */
export function pinPlace(x: number, y: number): string {
  const row = y < 34 ? 'upper' : y > 66 ? 'lower' : 'middle'
  const col = x < 34 ? 'left' : x > 66 ? 'right' : 'center'
  if (row === 'middle' && col === 'center') return 'center'
  if (row === 'middle') return `middle ${col}`
  return col === 'center' ? `${row === 'upper' ? 'top' : 'bottom'} center` : `${row} ${col}`
}

/** What a pinned spot is on a web page, read from the page itself (BrowserPanel). */
export interface PinElement {
  tag: string
  role?: string
  name?: string
  text?: string
  selector?: string
  href?: string
}

export function describePinElement(element: PinElement): string {
  const parts = [`<${element.tag}>`]
  if (element.name || element.text) parts.push(`"${(element.name || element.text || '').slice(0, 120)}"`)
  if (element.role) parts.push(`role ${element.role}`)
  if (element.selector) parts.push(`selector ${element.selector}`)
  if (element.href) parts.push(`link ${element.href}`)
  return parts.join(' · ')
}

/**
 * What the model gets with a pin comment besides its one-line text: where the
 * spot is in words and pixels, what is there on a web page, and what the
 * attached pictures show.
 */
export function pinCommentContext(input: { name: string; n: number; x: number; y: number; width?: number; height?: number; element?: PinElement | null; pictures: boolean }): string {
  const lines = [`Pin ${input.n} on ${input.name.trim() || 'this image'}: ${pinPlace(input.x, input.y)}, ${input.x}% from the left and ${input.y}% from the top.`]
  if (input.width && input.height) lines.push(`That is pixel ${Math.round(input.x / 100 * input.width)} × ${Math.round(input.y / 100 * input.height)} of a ${input.width} × ${input.height} picture.`)
  if (input.element) lines.push(`On the page, the spot is on ${describePinElement(input.element)}.`)
  lines.push(input.pictures
    ? `The first attached picture is the whole image with pin ${input.n} drawn at the spot (a red circle with the number). The second is a close-up around the pin. The comment is about what is under the pin.`
    : 'No picture is attached (the image could not be copied), so go by the position.')
  return lines.join('\n')
}

// The pin is drawn into the picture the model reads, so it uses fixed colours
// that show on light and dark images, not the UI theme.
const PIN_FILL = '#e5484d'
const PIN_EDGE = '#ffffff'

function canvasFile(canvas: HTMLCanvasElement, name: string): Promise<File | null> {
  return new Promise(resolve => {
    try {
      canvas.toBlob(blob => resolve(blob ? new File([blob], name, { type: 'image/png' }) : null), 'image/png')
    } catch { resolve(null) } // a picture from another site cannot be copied
  })
}

function drawPin(context: CanvasRenderingContext2D, x: number, y: number, radius: number, n: number) {
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fillStyle = PIN_FILL
  context.fill()
  context.lineWidth = Math.max(2, radius / 5)
  context.strokeStyle = PIN_EDGE
  context.stroke()
  context.fillStyle = PIN_EDGE
  context.font = `bold ${Math.round(radius * 1.1)}px sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(String(n), x, y + radius * 0.05)
}

/**
 * The picture with the pin drawn on it, and a close-up around the pin, for the
 * model to read. Null when the picture can't be read (not loaded, or from
 * another site).
 */
export async function pinnedPictures(image: HTMLImageElement, fx: number, fy: number, n: number, base = 'pin'): Promise<{ marked: File; closeUp: File; width: number; height: number } | null> {
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height || typeof document === 'undefined') return null
  const scale = Math.min(1, 2000 / Math.max(width, height))
  const full = document.createElement('canvas')
  full.width = Math.round(width * scale)
  full.height = Math.round(height * scale)
  const fullContext = full.getContext('2d')
  if (!fullContext) return null
  fullContext.drawImage(image, 0, 0, full.width, full.height)
  drawPin(fullContext, fx * full.width, fy * full.height, Math.max(12, Math.min(full.width, full.height) * 0.025), n)

  const side = Math.max(160, Math.round(Math.min(width, height) * 0.3))
  const cropX = Math.min(Math.max(0, Math.round(fx * width - side / 2)), Math.max(0, width - side))
  const cropY = Math.min(Math.max(0, Math.round(fy * height - side / 2)), Math.max(0, height - side))
  const cropW = Math.min(side, width)
  const cropH = Math.min(side, height)
  const zoom = Math.min(4, 512 / Math.max(cropW, cropH))
  const close = document.createElement('canvas')
  close.width = Math.round(cropW * zoom)
  close.height = Math.round(cropH * zoom)
  const closeContext = close.getContext('2d')
  if (!closeContext) return null
  closeContext.imageSmoothingEnabled = zoom < 2
  closeContext.drawImage(image, cropX, cropY, cropW, cropH, 0, 0, close.width, close.height)
  drawPin(closeContext, (fx * width - cropX) * zoom, (fy * height - cropY) * zoom, 14, n)

  const [marked, closeUp] = await Promise.all([canvasFile(full, `${base}-pin-${n}.png`), canvasFile(close, `${base}-pin-${n}-close-up.png`)])
  return marked && closeUp ? { marked, closeUp, width, height } : null
}
