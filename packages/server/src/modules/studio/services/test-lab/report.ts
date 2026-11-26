/**
 * The report a Test Lab agent writes (docs/test-lab.md), in a fixed format:
 *
 *   # Test Lab report
 *   ## Summary
 *   <text>
 *   ## Checks
 *   - [PASS] <name> — <detail>
 *   - [FAIL] <name> — <detail>
 *   - [SKIP] <name>
 */

export type CheckResult = 'pass' | 'fail' | 'skip'
export interface ReportCheck { name: string; result: CheckResult; detail?: string }
export interface ParsedReport { summary: string; checks: ReportCheck[]; passed: number; failed: number; skipped: number }

const LINE = /^\s*[-*]\s*\[\s*(pass|passed|ok|fail|failed|skip|skipped)\s*\]\s*(.+?)\s*$/i
const SEPARATOR = /\s+(?:—|–|--|-)\s+|:\s+/

export function parseReport(markdown: string): ParsedReport {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const checks: ReportCheck[] = []
  const summary: string[] = []
  let section = ''
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) { section = heading[1].trim().toLowerCase(); continue }
    const match = LINE.exec(line)
    if (match) {
      const word = match[1].toLowerCase()
      const result: CheckResult = word.startsWith('p') || word === 'ok' ? 'pass' : word.startsWith('f') ? 'fail' : 'skip'
      const rest = match[2]
      const split = SEPARATOR.exec(rest)
      const name = (split ? rest.slice(0, split.index) : rest).trim()
      const detail = split ? rest.slice(split.index + split[0].length).trim() : ''
      checks.push({ name: name.slice(0, 300), result, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })
      continue
    }
    if (section.startsWith('summary') && line.trim()) summary.push(line.trim())
  }
  return {
    summary: summary.join('\n').slice(0, 4000),
    checks,
    passed: checks.filter(check => check.result === 'pass').length,
    failed: checks.filter(check => check.result === 'fail').length,
    skipped: checks.filter(check => check.result === 'skip').length,
  }
}
