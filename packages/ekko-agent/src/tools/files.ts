import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AgentToolError, type AgentTool, type AgentToolContext, type AgentToolResult } from './types'
import { resolveToolPath, resolveUnrestrictedToolPath } from './path-safety'
import { markFileRead, wasFileRead } from './read-tracking'

export const DEFAULT_READ_FILE_MAX_BYTES = 50_000

export interface ReadFileInput extends Record<string, unknown> {
  path: string
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

export interface WriteFileInput extends Record<string, unknown> {
  path: string
  content: string
  encoding?: BufferEncoding
  createDirs?: boolean
}

export class ReadFileTool implements AgentTool<ReadFileInput> {
  readonly concurrency = 'parallel' as const

  readonly definition = {
    name: 'read_file',
    description: `Read a text file from the local filesystem, reading at most ${DEFAULT_READ_FILE_MAX_BYTES} file bytes per call. Relative paths resolve from the current working directory; absolute paths and paths outside workspaceRoot are supported. Use offset to continue a truncated read.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths resolve from the current working directory; absolute paths are supported.' },
        encoding: { type: 'string', description: 'Text encoding. Defaults to utf8.' },
        offset: { type: 'number', description: 'Zero-based byte offset. Defaults to 0; use nextOffset from a truncated result to continue.' },
        limit: { type: 'number', description: `Maximum file bytes to read (minimum 4). Defaults to and cannot exceed ${DEFAULT_READ_FILE_MAX_BYTES}.` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }

  async execute(input: ReadFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveUnrestrictedToolPath(input.path, context)
    const encoding = normalizeReadEncoding(input.encoding)
    const offset = nonNegativeInteger(input.offset, 'offset', 0)
    const requestedLimit = positiveInteger(input.limit, 'limit', DEFAULT_READ_FILE_MAX_BYTES, 4)
    const limit = Math.min(requestedLimit, DEFAULT_READ_FILE_MAX_BYTES)
    const file = await open(filePath, 'r')

    try {
      const fileInfo = await file.stat()
      const availableBytes = Math.max(0, fileInfo.size - offset)
      const readCapacity = Math.min(availableBytes, limit)
      const buffer = Buffer.alloc(readCapacity)
      const bytesRead = readCapacity > 0
        ? (await file.read(buffer, 0, readCapacity, offset)).bytesRead
        : 0
      const returnedBytes = decodedByteBoundary(
        buffer.subarray(0, bytesRead),
        encoding,
        offset,
        availableBytes > bytesRead,
      )
      const nextOffset = offset + returnedBytes
      const truncated = nextOffset < fileInfo.size
      const chunk = buffer.subarray(0, returnedBytes).toString(encoding)
      const content = truncated
        ? `${chunk}${chunk && !chunk.endsWith('\n') ? '\n' : ''}\n[read_file truncated: returned bytes ${offset}-${nextOffset - 1} of ${fileInfo.size}; call again with offset=${nextOffset}]`
        : chunk

      markFileRead(context.sessionId, filePath)
      return {
        ok: true,
        content,
        data: {
          path: filePath,
          bytes: returnedBytes,
          totalBytes: fileInfo.size,
          offset,
          nextOffset,
          truncated,
          limit,
        },
      }
    } finally {
      await file.close()
    }
  }
}

export class WriteFileTool implements AgentTool<WriteFileInput> {
  readonly definition = {
    name: 'write_file',
    description: 'Write UTF-8 text content to a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the current workspace.' },
        content: { type: 'string', description: 'Text content to write.' },
        encoding: { type: 'string', description: 'Text encoding. Defaults to utf8.' },
        createDirs: { type: 'boolean', description: 'Create parent directories before writing. Defaults to true.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  }

  async execute(input: WriteFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveToolPath(input.path, context)
    if (input.createDirs !== false) {
      await mkdir(path.dirname(filePath), { recursive: true })
    }
    await writeFile(filePath, input.content, input.encoding || 'utf8')
    return {
      ok: true,
      content: `Wrote ${Buffer.byteLength(input.content, input.encoding || 'utf8')} bytes to ${filePath}`,
      data: {
        path: filePath,
        bytes: Buffer.byteLength(input.content, input.encoding || 'utf8'),
      },
    }
  }
}

export interface EditFileInput extends Record<string, unknown> {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export class EditFileTool implements AgentTool<EditFileInput> {
  readonly definition = {
    name: 'edit_file',
    description: [
      'Replace an exact substring in an existing text file — a targeted change instead of rewriting the whole file.',
      'oldString must match the file exactly (including whitespace and indentation) and, unless replaceAll is set, must occur exactly once; the call fails loudly instead of guessing if it is missing or ambiguous.',
      'Read the file with read_file first: editing a path that has not been read this session is rejected, since oldString almost certainly needs to be copied from real file content, not assumed.',
      'Use write_file instead for a brand-new file, or when replacing the whole file body is genuinely the intent.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the current workspace.' },
        oldString: { type: 'string', description: 'Exact text to replace. Must be unique in the file unless replaceAll is true.' },
        newString: { type: 'string', description: 'Replacement text. May be empty to delete oldString.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldString instead of requiring exactly one. Defaults to false.' },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
  }

  async execute(input: EditFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveToolPath(input.path, context)

    let fileInfo
    try {
      fileInfo = await stat(filePath)
    } catch {
      return {
        ok: false,
        content: `${filePath} does not exist. Use write_file to create a new file.`,
        error: 'file not found',
      }
    }
    if (!fileInfo.isFile()) {
      return { ok: false, content: `${filePath} is not a regular file.`, error: 'not a file' }
    }
    if (!wasFileRead(context.sessionId, filePath)) {
      return {
        ok: false,
        content: `${filePath} has not been read in this session yet. Call read_file on it first — edit_file's oldString must be copied from real file content, not assumed.`,
        error: 'read required before edit',
      }
    }
    if (input.oldString === input.newString) {
      return { ok: false, content: 'oldString and newString are identical; nothing to change.', error: 'no-op edit' }
    }

    const original = await readFile(filePath, 'utf8')
    const occurrences = countOccurrences(original, input.oldString)
    if (occurrences === 0) {
      return {
        ok: false,
        content: `oldString was not found in ${filePath}. It must match the file's current content exactly, including whitespace — re-read the file if it may have changed.`,
        error: 'oldString not found',
      }
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        ok: false,
        content: `oldString occurs ${occurrences} times in ${filePath}, but must be unique unless replaceAll is set. Include more surrounding context to make it unique, or pass replaceAll=true to change every occurrence.`,
        error: 'oldString not unique',
      }
    }

    const updated = input.replaceAll
      ? original.split(input.oldString).join(input.newString)
      : replaceOnce(original, input.oldString, input.newString)

    await atomicWriteFile(filePath, updated)
    markFileRead(context.sessionId, filePath) // the file on disk now matches what we just wrote; still "read".

    return {
      ok: true,
      content: `Replaced ${input.replaceAll ? `${occurrences} occurrences` : '1 occurrence'} in ${filePath}.`,
      data: { path: filePath, occurrences: input.replaceAll ? occurrences : 1, bytes: Buffer.byteLength(updated, 'utf8') },
    }
  }
}

export function createFileTools(): AgentTool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
  ]
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle)
  return `${haystack.slice(0, index)}${replacement}${haystack.slice(index + needle.length)}`
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.edit-${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, content, 'utf8')
    try {
      await rename(temporaryPath, filePath)
    } catch {
      // Some platforms/filesystems won't atomically replace an existing
      // destination via rename; fall back to a direct write.
      await writeFile(filePath, content, 'utf8')
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function normalizeReadEncoding(value: BufferEncoding | undefined): BufferEncoding {
  const encoding = value || 'utf8'
  if (!Buffer.isEncoding(encoding)) {
    throw new AgentToolError(`Unsupported text encoding: ${encoding}`, 'INVALID_TOOL_INPUT')
  }
  return encoding
}

function nonNegativeInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentToolError(`${name} must be a non-negative integer.`, 'INVALID_TOOL_INPUT')
  }
  return value
}

function positiveInteger(value: number | undefined, name: string, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AgentToolError(`${name} must be an integer greater than or equal to ${minimum}.`, 'INVALID_TOOL_INPUT')
  }
  return value
}

function decodedByteBoundary(buffer: Buffer, encoding: BufferEncoding, offset: number, hasMore: boolean): number {
  let end = buffer.length
  if (!hasMore || end === 0) return end
  const normalized = encoding.toLowerCase()
  if (normalized === 'utf8' || normalized === 'utf-8') {
    let lead = end - 1
    while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1
    if (lead < 0) return end
    const expectedBytes = utf8SequenceBytes(buffer[lead])
    if (expectedBytes > end - lead) end = lead
    return end
  }
  if (
    (normalized === 'utf16le' || normalized === 'utf-16le' || normalized === 'ucs2' || normalized === 'ucs-2')
    && (offset + end) % 2 !== 0
  ) {
    return end - 1
  }
  return end
}

function utf8SequenceBytes(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1
  if ((leadByte & 0xe0) === 0xc0) return 2
  if ((leadByte & 0xf0) === 0xe0) return 3
  if ((leadByte & 0xf8) === 0xf0) return 4
  return 1
}
