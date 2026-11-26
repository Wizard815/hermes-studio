/**
 * Studio's per-turn context blocks (`<studio_task_plan_context>`,
 * `<studio_session_tasks_context>`, `<studio_interaction_context>`) are for the
 * agent, not for people. Where they still sit in a user message (agents other
 * than Claude Code, or a session from before the hook), anything that shows
 * that message to people strips them.
 */
const BLOCK = /\s*<(studio_[a-z_]+_context)>[\s\S]*?<\/\1>\s*/g

export function stripStudioContextBlocks(text: string): string {
  if (!text || !text.includes('<studio_')) return text
  return text.replace(BLOCK, '\n\n').trim()
}
