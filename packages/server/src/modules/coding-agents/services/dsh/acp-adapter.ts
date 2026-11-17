import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshPackageDirectory } from './installation'
import { DshPluginError } from './errors'

// New releases can use the adapter when the required integration seams remain
// compatible. Record the source hash for diagnostics, never as an allowlist.
export const DSH_ACP_ADAPTER_REVISION = 7

export async function writeDshAcpAdapter(installation: string, destination: string, acpAppDirectory: string) {
  // ACP belongs to the selected bundle and may be nested beneath it. Resolve
  // from that owner so we adapt the same copy the native profile would load.
  const directory = await dshPackageDirectory('@deepseek-ai/dsh-acp', [join(acpAppDirectory, 'package.json')])
  const filename = join(directory, 'lib/index.js')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const original = await readFile(filename, 'utf8')
  const sourceHash = createHash('sha256').update(original).digest('hex')
  let source = adaptDshAcpSource(original, manifest.version)
  const require = createRequire(filename)
  // Keep every import bound to the candidate's actual dependency graph.
  source = source.replace(/from "([^"\n]+)"/g, (match, specifier: string) => specifier.startsWith('node:') ? match : `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`)
  const license = await readFile(join(directory, 'LICENSE'), 'utf8').catch(() => readFile(join(dirname(installation), 'LICENSE'), 'utf8'))
  await writeFile(destination + '.LICENSE', license)
  await writeFile(destination, `// Studio DSH ACP adapter revision ${DSH_ACP_ADAPTER_REVISION}; upstream ${manifest.version} (MIT); source sha256 ${sourceHash}.\n` + source, { mode: 0o600 })
}

// Applied after native restoration/preset initialization, before any prompt;
// it also replaces persisted workspace-write/ask values on old sessions.
// STUDIO_DSH_APPROVAL=ask (the Agents page approval mode) makes DSH ask first.
const DSH_PERMISSION_POLICY = 'setSandboxMode(this.agent.session, process.env.STUDIO_DSH_APPROVAL === "ask" ? "workspace-write" : "danger-full-access");\nsetApprovalPolicy(this.agent.session, process.env.STUDIO_DSH_APPROVAL === "ask" ? "ask" : "never");'

export function adaptDshAcpSource(source: string, version: string): string {
  const replaceVariants = (capability: string, variants: [string, string][], count = 1) => {
    const found = variants.reduce((total, [before]) => total + source.split(before).length - 1, 0)
    if (found !== count) throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED',
      `DSH ACP ${version || 'unknown version'} is incompatible with Studio's ${capability} adapter: expected ${count} integration point(s), found ${found}. The installed DSH files were not changed.`)
    for (const [before, after] of variants) source = source.split(before).join(after)
  }
  const replace = (capability: string, before: string, after: string, count = 1) => replaceVariants(capability, [[before, after]], count)
  // 0.2.2 moved model ownership into Agent and shares a native setup hook.
  // Keep the two verified contracts separate: never infer support from version
  // alone, and never omit a permission/persistence/preset capability on failure.
  const agentFactory = source.includes('async function composeAgent(agentCtx, options)')
  const option = (indent: string, value: string) => {
    const before = `agentOptions: agentOptions(config),\n${indent}${agentFactory ? 'signal,' : 'fallbackSelection:'}`
    replace('preset selection', before, `agentOptions: agentOptions(config),\n${indent}agentPreset: ${value},\n${indent}${agentFactory ? 'signal,' : 'fallbackSelection:'}`)
  }
  option('\t\t\t\t\t', 'params._meta?.agentPreset')
  option('\t\t\t\t\t\t', 'agentPreset')
  replace('preset persistence', 'meta: { cwd: options.cwd },', 'meta: { cwd: options.cwd, agentPreset: options.agentPreset },')
  const mount = 'await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);'
  replace('preset mounting', mount, mount + '\nawait ctx.agentPresets.mount(agentCtx, options.agentPreset);', agentFactory ? 1 : 2)
  const resumable = agentFactory
    ? 'if (persisted === void 0 || persisted.origin === "subagent") throw invalidParams(`session is not resumable: ${sessionId}`);'
    : 'if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) throw invalidParams(`session is not resumable: ${sessionId}`);'
  replace('preset restoration', resumable, resumable + '\nconst agentPreset = persisted.agentPreset ?? ctx.agentPresets.defaultId;')
  if (agentFactory) {
    // Native setup runs before publication, for both create and resume.
    replace('preset setup context', 'async function composeAgent(agentCtx, options) {', 'async function composeAgent(ctx, agentCtx, options) {')
    replace('preset setup callers', 'setup: (agentCtx) => composeAgent(agentCtx, options)', 'setup: (agentCtx) => composeAgent(ctx, agentCtx, options)', 2)
    replace('default preset selection', 'static async create(ctx, options) {', 'static async create(ctx, options) {\noptions.agentPreset ??= ctx.agentPresets.defaultId;')
    const model = 'this.modelControl = new AcpModelControl(ctx.llm, handle.agent.model);'
    replace('session permission policy', model, model + '\n' + DSH_PERMISSION_POLICY)
  } else {
    replace('default preset selection', 'const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);',
      'options.agentPreset ??= ctx.agentPresets.defaultId;\nconst modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);')
    replace('session permission policy', 'this.modelControl = modelControl;', 'this.modelControl = modelControl;\n' + DSH_PERMISSION_POLICY)
  }
  // Newer ACP waits for descendants and cancellation as well as root/output
  // quiescence. Flush after that whole drain, before releasing the prompt slot.
  const turnPersistencePoints = [
    'if (inflight.messageQueued) {\n\t\t\t\tawait this.agent.whenIdle();\n\t\t\t\tawait this.outputTail;',
    'if (isCancelled() || idleAt(idleSeq)) break;\n\t\t\t\t}\n\t\t\t\tif (isCancelled()) await cancelled;',
  ]
  replaceVariants('turn persistence', turnPersistencePoints.map(before => [before, before + '\n\t\t\t\tawait this.ctx.sessions.flush(this.agent.session);']))
  return 'import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";\nimport { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";\n' + source
}
