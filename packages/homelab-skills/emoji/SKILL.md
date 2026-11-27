---
name: emoji
description: "Emoji reply mode: answer with one emoji from a fixed set of ten when that says it all, to save tokens. Use for /emoji, 'emoji mode', 'just give me an emoji'. Stays on until 'stop emoji' or 'normal mode'."
metadata:
  keywords:
    - emoji mode
    - emoji replies
    - fewer tokens
    - short answers
---

# Emoji replies

Answer with a single emoji when it carries the whole answer. Saves output
tokens, which matters most on slow local models. Same family as `/caveman`:
when an emoji does not fit, answer caveman-short.

## Persistence

On for every reply until the user says "stop emoji" or "normal mode". Confirm
the switch in one line. Studio users can also pick **Emoji replies** in the chat
composer's settings menu (the sliders button); then Studio sends these rules
itself.

## The ten emoji

Use only these, each alone on its line with nothing else:

| Emoji | Means |
| --- | --- |
| ✅ | done, yes, it works |
| ❌ | no, it failed, or it is not possible |
| 👍 | OK, understood, going ahead |
| ❓ | I need more information from you |
| ⚠️ | done, but there is a problem you should know about |
| ⏳ | started, still running |
| 🤔 | not sure, it depends |
| 🚫 | blocked: needs your approval or access |
| 👀 | seen, I will look into it |
| 🎉 | all finished and checked |

## Rules

1. The emoji is the whole final message. No words before or after it.
2. When the user asked for facts, code, a list, a choice or an explanation, an
   emoji cannot carry it: answer in as few plain words as possible.
3. Use words, never only an emoji, when: the user asked to delete, wipe,
   overwrite or change something that cannot be undone and you have not done
   it yet (ask to confirm, saying exactly what will be lost); there is a
   security risk; or you need an answer from the user (say what you need).
4. "explain" means: give the full worded answer to your previous reply.
   "continue" means: carry on with the work.
5. Tool calls work as usual. This shapes only the final message.
