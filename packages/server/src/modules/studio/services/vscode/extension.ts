import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Studio's own VS Code extension, written into code-server's extensions folder
 * on start: "Follow agent edits" opens files as an agent changes them and
 * scrolls to the change. The status bar item turns it on and off.
 */
export const STUDIO_EXTENSION_ID = 'hermes-studio.studio-follow'
export const STUDIO_EXTENSION_VERSION = '0.1.0'

const PACKAGE_JSON = {
  name: 'studio-follow',
  displayName: 'Hermes Studio',
  description: 'Follow agent edits: opens the files an agent changes.',
  publisher: 'hermes-studio',
  version: STUDIO_EXTENSION_VERSION,
  license: 'MIT',
  engines: { vscode: '^1.80.0' },
  categories: ['Other'],
  activationEvents: ['onStartupFinished'],
  main: './extension.js',
  contributes: {
    commands: [{ command: 'hermesStudio.toggleFollow', title: 'Hermes Studio: Toggle Follow Agent Edits' }],
    configuration: {
      title: 'Hermes Studio',
      properties: {
        'hermesStudio.followAgentEdits': {
          type: 'boolean',
          default: true,
          description: 'Open files an agent changes and scroll to the change.',
        },
      },
    },
  },
}

/** Files that change all the time and are never worth following. */
export const IGNORED_PATH = /(^|[\\/])(\.git|node_modules|dist|build|out|\.next|\.nuxt|\.cache|coverage|__pycache__|\.venv|venv|target)([\\/]|$)|(\.lock|-lock\.json|lock\.yaml|\.log|\.map|\.tmp|\.swp|~)$/

const EXTENSION_JS = `'use strict'
const vscode = require('vscode')
const IGNORED = ${IGNORED_PATH.toString()}
const MAX_SIZE = 2000000

function firstChangedLine(before, after) {
  if (typeof before !== 'string') return 0
  const a = before.split('\\n'), b = after.split('\\n')
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n < b.length ? n : Math.max(0, b.length - 1)
}

function activate(context) {
  const config = () => vscode.workspace.getConfiguration('hermesStudio')
  const following = () => config().get('followAgentEdits', true)
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  item.command = 'hermesStudio.toggleFollow'
  const render = () => {
    item.text = following() ? '$(eye) Following agent' : '$(eye-closed) Not following'
    item.tooltip = 'Hermes Studio: open files the agent changes (click to turn ' + (following() ? 'off' : 'on') + ')'
    item.show()
  }
  render()
  const userTouched = new Map()
  const known = new Map()
  const remember = (doc) => { if (doc.uri.scheme === 'file' && doc.getText().length < MAX_SIZE) known.set(doc.uri.toString(), doc.getText()) }
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('hermesStudio.toggleFollow', async () => {
      await config().update('followAgentEdits', !following(), vscode.ConfigurationTarget.Global)
      render()
    }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('hermesStudio')) render() }),
    // Your own typing and saving is not an agent edit.
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && event.document.isDirty) userTouched.set(event.document.uri.toString(), Date.now())
    }),
    vscode.workspace.onWillSaveTextDocument(event => userTouched.set(event.document.uri.toString(), Date.now())),
    vscode.workspace.onDidOpenTextDocument(remember),
  )
  for (const doc of vscode.workspace.textDocuments) remember(doc)

  const show = async (uri) => {
    if (!following() || uri.scheme !== 'file' || IGNORED.test(uri.path)) return
    if (Date.now() - (userTouched.get(uri.toString()) || 0) < 3000) return
    let stat
    try { stat = await vscode.workspace.fs.stat(uri) } catch { return }
    if (stat.type !== vscode.FileType.File || stat.size > MAX_SIZE) return
    const before = known.get(uri.toString())
    const doc = await vscode.workspace.openTextDocument(uri)
    const after = doc.getText()
    if (after.includes('\\u0000')) return
    known.set(uri.toString(), after)
    const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
    const line = Math.min(firstChangedLine(before, after), Math.max(0, doc.lineCount - 1))
    const range = new vscode.Range(line, 0, line, 0)
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  let pending = null
  let timer = null
  const queue = (uri) => {
    pending = uri
    clearTimeout(timer)
    timer = setTimeout(() => {
      const next = pending
      pending = null
      if (next) show(next).catch(() => {})
    }, 400)
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/*')
  context.subscriptions.push(watcher, watcher.onDidChange(queue), watcher.onDidCreate(queue), { dispose: () => clearTimeout(timer) })
}

function deactivate() {}

module.exports = { activate, deactivate, firstChangedLine }
`

/** Writes the extension and registers it in the extensions folder's index. */
export function installStudioExtension(extensionsDir: string) {
  const folderName = `${STUDIO_EXTENSION_ID}-${STUDIO_EXTENSION_VERSION}`
  const folder = join(extensionsDir, folderName)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`)
  writeFileSync(join(folder, 'extension.js'), EXTENSION_JS)

  const index = join(extensionsDir, 'extensions.json')
  let entries: any[] = []
  try { entries = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')) : [] } catch { entries = [] }
  if (!Array.isArray(entries)) entries = []
  entries = entries.filter(entry => String(entry?.identifier?.id || '').toLowerCase() !== STUDIO_EXTENSION_ID)
  entries.push({
    identifier: { id: STUDIO_EXTENSION_ID },
    version: STUDIO_EXTENSION_VERSION,
    location: { $mid: 1, fsPath: folder, external: `file://${folder}`, path: folder, scheme: 'file' },
    relativeLocation: folderName,
    metadata: { installedTimestamp: Date.now(), source: 'vsix' },
  })
  writeFileSync(index, JSON.stringify(entries))
}

/** The extension's source, for tests. */
export function studioExtensionSource(): string {
  return EXTENSION_JS
}
