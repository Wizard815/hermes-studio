import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetMarkitdownCommand, markdownCopyNote, writeMarkdownCopy,
} from '../../packages/server/src/modules/studio/services/files/markitdown'
import { convertContentBlocksForAgent } from '../../packages/server/src/modules/studio/services/chat-run/content-blocks'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'markitdown-')); forgetMarkitdownCommand() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.STUDIO_MARKITDOWN })

/** A fake markitdown: `--version` works, a conversion writes "# converted" to -o. */
function fakeRunner(available: Record<string, boolean>) {
  return vi.fn(async (command: string, args: string[]) => {
    if (!available[command]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const out = args.indexOf('-o')
    if (out >= 0) writeFileSync(args[out + 1], '# converted\n')
  })
}

describe('Markdown copies of attachments', () => {
  it('converts a PDF next to the upload and tells the model where the copy is', async () => {
    const pdf = join(dir, 'abc.pdf')
    writeFileSync(pdf, '%PDF-1.4')
    const runner = fakeRunner({ markitdown: true })
    expect(await writeMarkdownCopy(pdf, runner)).toBe(`${pdf}.md`)
    const [part] = await convertContentBlocksForAgent([{ type: 'file', name: 'report.pdf', path: pdf } as any])
    expect(part).toMatchObject({ type: 'text' })
    expect((part as any).text).toContain(`Markdown copy for reading: ${pdf}.md`)
  })

  it('falls back to uvx with the pinned version', async () => {
    const docx = join(dir, 'a.docx')
    writeFileSync(docx, 'x')
    const runner = fakeRunner({ uvx: true })
    expect(await writeMarkdownCopy(docx, runner)).toBe(`${docx}.md`)
    expect(runner.mock.calls.at(-1)![1].slice(0, 3)).toEqual(['--from', 'markitdown[all]==0.1.9', 'markitdown'])
  })

  it('leaves text files, missing markitdown and STUDIO_MARKITDOWN=0 alone', async () => {
    const txt = join(dir, 'a.txt')
    const pdf = join(dir, 'b.pdf')
    writeFileSync(txt, 'x')
    writeFileSync(pdf, 'x')
    expect(await writeMarkdownCopy(txt, fakeRunner({ markitdown: true }))).toBeNull()
    expect(await writeMarkdownCopy(pdf, fakeRunner({}))).toBeNull()
    process.env.STUDIO_MARKITDOWN = '0'
    forgetMarkitdownCommand()
    expect(await writeMarkdownCopy(pdf, fakeRunner({ markitdown: true }))).toBeNull()
    expect(existsSync(`${pdf}.md`)).toBe(false)
    expect(markdownCopyNote(pdf)).toBe('')
  })
})
