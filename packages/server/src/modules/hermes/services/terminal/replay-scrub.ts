/**
 * Strip terminal query sequences from replayed terminal output.
 *
 * The attach client's raw output history is replayed into xterm.js whenever a
 * socket (re)connects, so the pane repaints instead of flashing empty. But raw
 * history also contains the queries tmux sent to its "terminal" when the
 * attach client started: DA1/DA2 (ESC[c / ESC[>c), XTGETTCAP, OSC color
 * probes. xterm.js answers a query no matter how old it is, and by replay time
 * nothing is waiting for the answer — tmux forwards the reply to the pane as
 * typed input, and the prompt shows phantom text like "1;2c0;276;0c" every
 * time the panel is reopened. Scrub queries out of replayed data only; live
 * output must stay untouched so the real attach-time handshake still works.
 */

// Each alternative is a sequence that asks the terminal to answer with a
// report. None of them produce visible output, so dropping them never changes
// what the replay paints.
const QUERY_SEQUENCE = new RegExp(
  [
    // DA1/DA2/DA3 and DSR/CPR: CSI, optional ? > =, params, final c or n
    // (lowercase only — cursor-forward is capital C and must survive).
    '\\x1b\\[[?>=]?[0-9;]*[cn]',
    // XTVERSION (CSI > q) and the kitty keyboard-protocol probe (CSI ? u).
    '\\x1b\\[>[0-9;]*q',
    '\\x1b\\[\\?[0-9;]*u',
    // DECRQM mode queries: CSI ? Pm $ p.
    '\\x1b\\[\\??[0-9;]*\\$p',
    // DCS string queries — XTGETTCAP (DCS + q) and DECRQSS (DCS $ q) — through
    // their BEL/ST terminator. Sixel and other DCS payloads do not start with
    // "+q"/"$q" and are left alone.
    '\\x1bP[+$]q[^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)',
    // OSC color probes (OSC 10;? / 11;? / 4;N;? …) through BEL or ST.
    '\\x1b\\][0-9;]*;\\?[^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)',
  ].join('|'),
  'g',
)

export function stripTerminalQueries(data: string): string {
  if (!data || !data.includes('\x1b')) return data
  return data.replace(QUERY_SEQUENCE, '')
}
