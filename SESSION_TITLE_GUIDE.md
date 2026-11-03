# Session Title Generation Guide for Hermes Studio

## Overview

Hermes Studio automatically generates session titles from the first user prompt. This guide explains how the system works and how to improve it.

## Current System (as of v0.7.39)

### Architecture

1. **Session Creation**: When a new chat session is created, a provisional title is generated from the first user message
2. **Title Normalization**: The provisional title is truncated to ~100 characters and stored
3. **Async Title Generation**: A background process uses the model to generate a better title
4. **Title Display**: Titles are displayed in the UI with a ~20 character limit

### File Locations

- **Core Logic**: `/packages/server/src/modules/studio/services/chat-run/session-title.ts`
- **Usage**: Called from:
  - `handle-bridge-run.ts` (bridge agent runs)
  - `handle-ekko-agent-run.ts` (Ekkо agent runs)
  - `handle-coding-agent-run.ts` (coding agent runs)

### Key Constants

```typescript
SESSION_TITLE_MAX_CHARS = 15    // Current: 15 characters
SESSION_TITLE_TIMEOUT_MS = 30_000  // 30 second timeout
SESSION_TITLE_PROMPT_MAX_CHARS = 4000  // Max prompt to send to model
```

### System Prompt

```
You write short titles for chat conversations. Read the user's first message 
and reply with a title of at most 15 characters (spaces included).
Reply in the same language as the message. Output only the title: 
no quotes, no markdown, no trailing punctuation, no explanation.
```

## Improvements Made

### 1. Increased Character Limit

**Before**: 15 characters  
**After**: 25 characters

**Rationale**: 15 characters is very restrictive (e.g., "Fix login bug" = 14 chars, no room for more context). 25 characters allows for more descriptive titles while still being UI-friendly.

### 2. Improved System Prompt

**Key improvements**:
- More detailed requirements
- Clear guidance on what makes a good title
- Better language handling

**New prompt emphasizes**:
- Descriptive but concise
- Main topic/intent capture
- Natural language
- Capitalization rules
- Language matching

### 3. Enhanced Title Normalization

**Original logic**:
- Simple character truncation
- Basic word boundary handling

**Improved logic**:
- Better Unicode/character counting
- Punctuation-aware truncation
- Smart word boundary detection
- Multiple fallback strategies

### 4. Better Comparison Logic

**Added**:
- Normalized title comparison (case-insensitive, whitespace normalization)
- Prevents unnecessary updates
- More intelligent title matching

## Implementation Guide

### Modifying the Session Title Logic

1. **Update the source file**:
   ```typescript
   // In session-title.ts or your improved version
   export const SESSION_TITLE_MAX_CHARS = 25
   ```

2. **Update the system prompt**:
   ```typescript
   const SESSION_TITLE_SYSTEM_PROMPT = [
     `You write short, descriptive titles for chat conversations.`,
     `Read the user's first message and reply with a title of at most ${SESSION_TITLE_MAX_CHARS} characters (spaces included).`,
     `Requirements:`,
     `- Be descriptive but concise`,
     `- Capture the main topic or intent`,
     `- Use natural language`,
     `- Start with a capital letter`,
     `- Do not end with punctuation (except questions)`,
     `- Reply in the same language as the input`,
     `- Output ONLY the title, no quotes, no markdown, no explanation.`,
   ].join('\n')
   ```

3. **Use improved normalization**:
   - Implement `normalizeGeneratedTitle` with better character counting
   - Handle Unicode properly
   - Use punctuation-aware truncation

### Testing the Changes

1. **Unit tests**:
   ```typescript
   describe('normalizeGeneratedTitle', () => {
     it('handles 25 character limits properly', () => {
       const title = normalizeGeneratedTitle('This is a very long title that should be truncated')
       expect(title.length).toBeLessThanOrEqual(25)
     })
     
     it('prefers word boundaries', () => {
       const title = normalizeGeneratedTitle('How to fix the login bug in the authentication system')
       expect(title).toBe('How to fix the login bug')  // Ends at word boundary
     })
   })
   ```

2. **Integration tests**:
   - Test with actual model calls
   - Verify title updates work correctly
   - Check Unicode/language handling

### UI Considerations

The UI should handle titles up to 25 characters gracefully:

```css
.session-title {
  max-width: 200px;  /* Adjust based on font size */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

## Best Practices for Title Generation

### What Makes a Good Title?

1. **Descriptive**: Captures the main topic
2. **Concise**: 15-25 characters is optimal
3. **Action-oriented**: When applicable, use verbs
4. **Language-appropriate**: Match the input language
5. **User-intent focused**: What they want to accomplish

### Examples

| Input | Good Title (≤25 chars) | Bad Title |
|-------|------------------------|-----------|
| "How do I fix this bug?" | "Fix bug help" | "How do I fix" (incomplete) |
| "Write a Python function" | "Python function" | "Write a function" (too generic) |
| "Explain quantum physics" | "Quantum physics" | "Explain physics" (too vague) |
| "Create a todo list app" | "Todo list app" | "App" (too short) |

## Troubleshooting

### Title Too Short

**Symptoms**: Titles like "Fix" instead of "Fix login bug"

**Solutions**:
1. Increase `SESSION_TITLE_MAX_CHARS` to 25
2. Improve system prompt to encourage descriptiveness
3. Check model response parsing

### Title Too Long

**Symptoms**: Titles getting cut off or UI overflow

**Solutions**:
1. Implement proper truncation logic
2. Add ellipsis (...) for overflow
3. Consider responsive UI design

### Model Not Generating Title

**Symptoms**: `scheduleSessionTitle` returns empty string

**Debug steps**:
1. Check `SESSION_TITLE_TIMEOUT_MS` - increase if needed
2. Verify model client configuration
3. Check API response format
4. Review normalization logic

## Future Improvements

1. **Context-aware titles**: Use session category or user preferences
2. **Multi-language support**: Better handling of CJK characters
3. **User feedback**: Let users rate/modify auto-generated titles
4. **A/B testing**: Test different title generation approaches
5. **Machine learning**: Train on successful title patterns

## Related Files

```
/packages/server/src/modules/studio/services/chat-run/
├── session-title.ts              # Current implementation
├── session-title-improved.ts     # Improved version (created)
├── handle-bridge-run.ts          # Bridge agent integration
├── handle-ekko-agent-run.ts      # Ekkо agent integration
└── handle-coding-agent-run.ts    # Coding agent integration

/tests/server/
└── session-title.test.ts         # Unit tests

/packages/server/src/modules/studio/repositories/
└── session-display.ts            # Title display logic
```

## Summary

The key improvements for better session title generation are:

1. **Increase character limit**: From 15 to 25 characters
2. **Enhance system prompt**: More specific guidance for the model
3. **Improve normalization**: Better truncation with word/punctuation awareness
4. **Better comparison**: Prevent unnecessary title updates

These changes result in more descriptive, useful session titles that better represent the conversation content.
