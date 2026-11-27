# Reply styles: emoji and caveman

Cheaper answers, picked in the chat composer's settings menu (the sliders
button, under "Show tool calls"):

- **Normal replies**: as before.
- **Emoji replies (fewest tokens)**: when one emoji says it all, the reply is
  only that emoji. Otherwise the answer is as short as possible in words.
- **Caveman replies (short words)**: terse answers that keep every technical
  fact (the same voice as the `/caveman` skill).

While a style is on, a chip next to the composer buttons says so; click it to
go back to normal. The choice is kept for this browser and applies to every
chat (Hermes, Ekko and coding agents).

## The ten emoji

| Emoji | Means |
| --- | --- |
| ✅ | done, yes, it works |
| ❌ | no, it failed, or it is not possible |
| 👍 | OK, understood, going ahead |
| ❓ | needs more information from you |
| ⚠️ | done, but there is a problem to know about |
| ⏳ | started, still running |
| 🤔 | not sure, it depends |
| 🚫 | blocked: needs your approval or access |
| 👀 | seen, looking into it |
| 🎉 | all finished and checked |

Under an emoji reply Studio shows what it means, with **Explain** (sends
"explain": the agent gives the full worded answer) and **Continue** (sends
"continue"). You can also just reply in your own words.

The agent is told to use words, not an emoji, before a step that cannot be
undone (it asks you to confirm and says what will be lost), for a security
risk, and when it needs an answer from you.

Tried on 2026-11-27 with Llama 3.1 8B and Mistral Small 3.2 24B: both gave
✅ for a finished backup and a restart, ⏳ for a build still running, words for
"what port does Home Assistant use", and a worded confirm before deleting
snapshots.

## How it works, and local models

Studio adds the style's rules to the run's system instructions. They stay the
same while the style is on, so the prompt cache, and llama.cpp's KV cache
through Argos, keeps working; switching style costs one full re-read once.
Small local models follow the rules less reliably than large ones; if one
writes words around the emoji, Studio shows the words as they are and no card.

Outside Studio's chat (Hermes CLI, Telegram, other agents) use the bundled
skills: `/emoji`, `/caveman`, `/ultracave` ([homelab skills](homelab-skills.md)).

## What goes wrong

- **The agent still writes long answers.** The style applies from the next
  message you send. Check the chip is showing.
- **Explain gives a new answer instead of explaining.** Some models lose the
  thread on very short history; ask "explain your last reply" instead.
