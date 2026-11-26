# End-to-end test with OpenRouter (2026-11-25)

Branch tested: `studio-herder` (6217c46; round 4: 7e7855d). Fix branch: `e2e-openrouter`.
Model: `tencent/hy4-flash` on OpenRouter, the only model used (Studio, Hermes, Ekko, Claude Code, FAITH).
All data was fake (test users, test tasks, a demo Home Assistant).

## Summary

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Fresh start, recommended plugins | Pass | 7 of 8 installed once; print3d waits for Blender (as documented). A restart only retried print3d. Nothing broke without keys. |
| 2 | Hermes chat + approval | Pass | Read a file, ran `date`, then `rm -rf` asked "recursive delete"; Allow once worked. |
| 3 | Ekko chat + approval | Pass | Read a file; `rm -rf` asked "deletes files or directories"; Allow once worked. |
| 4 | Coding agent via the gateway | Pass | Claude Code edited a file, showed `git diff`, 69 tok/s speed, one MCP approval. No doubled text. |
| 5 | Run limits | Pass | `/limits tokens 20k` fired at 27,376 tokens; blocked state survived a restart; Continue (40k) finished the reply. |
| 6 | herdr | Pass after fix | Elevate, Herdr App layout, sync both ways, Return, Reopen all work. Reloaded chats hid pane turns: fixed. |
| 7 | Pondering Orb | Partial | Connect, Orb → Studio chat and Orb's progress view work. hy4-flash could not call the Orb tools itself; the tools work when called directly. |
| 8 | Agent work, 3-way approvals | Pass | One approval each from Mattermost (button), Studio and Orb; each Vikunja task was marked done. |
| 9 | Mattermost alerts | Pass | `#agentwork #blocked` and `#agentlimit #blocked` posts reached `~hermes` with `@testadmin`. Nothing was posted before the channel was set. |
| 10 | Home Assistant | Partial | Hermes listed the 6 demo lights and turned `light.bed_light` on. No approval was asked. |
| 11 | FAITH | Pass | `hermes_ask` answered a dinner question through Hermes's API server; `studio_start` started a Studio job (first try timed out, see below). |
| 12 | Gadget / D.A.S.H | Pass with gaps | Restart gateway works; a simulated device paired and showed the card Hermes sent; Studio's `/global-agent` subscription delivered chat events. |
| 13 | Watcher | Pass | Run on `watcher` (6530466) after its session said it was ready. The bell showed approvals, a run-limit hit and both clean-room alerts; Trust this let the next run through; auto mode ran without asking. |
| 14 | Clean room | Pass | Self-check, leak warning (`.env`) and egress log (`example.com` blocked) all show. |
| 15 | mcp-serve | Pass | Claude Code read the latest Hermes conversation through `hermes-chats`. |

## Scenario 13: watcher branch

At first this was skipped: `watcher`'s last commit (dc5ae7d) did not say it
was finished. Its session then reported the branch ready (6530466, "docs and
test checklist"). It was built in a separate worktree and run in a fresh test
home, with the same model and limits. The recommended-plugin install was
turned off there to avoid the `rea` delay.

- **Approvals in the bell:** an Ekko `rm -rf old-a` showed as "Warning ·
  Approval asked" with Open chat and Trust this. A Claude Code approval showed
  the same way.
- **Trust this:** the dialog offered the command, "This chat only", never
  expires. With the pattern `rm -rf old-*`, the next `rm -rf old-b` ran without
  a question. The rule is in `watcher.json`.
- **Run limits:** `/limits tokens 2k` gave "Blocked · Run limit hit".
- **Clean room:** "Clean room: possible secrets" (`.env`) and "Clean room:
  connection blocked" (`example.com:443`).
- **Auto mode:** after `/yolo`, Claude Code ran `rm -rf junk2` without asking,
  and no new alert was added.
- Notes: `/yolo` in a brand-new chat says "send a message first". The phone
  bell (drawer) was not screenshotted here; the branch's own Playwright test
  covers it.

![](w-bell-approval.png) ![](w-trust-dialog.png) ![](w-trusted-run.png)
![](w-bell-limit.png) ![](w-bell-cleanroom.png) ![](w-auto-mode.png)

## What was fixed

- `36d761f` fix(herdr): reopened chats show turns typed in herdr panes.
  The transcript mirror wrote pane turns to the database, but the chat-run
  socket resumed chats from a cache made before them. Reloading an elevated
  chat hid every turn typed in its pane until Studio restarted. The mirror now
  drops the chat's cached state when the chat is idle. Test:
  `tests/server/herdr-mirror-resume.test.ts`. Re-ran scenario 6: the pane
  turns show after a reload.

Checks: `npm run build` passes. herdr tests pass (4 files, 49 tests).
`npm run harness:check` fails with 29 findings, all already on `studio-herder`
(the same 29 with and without the fix: theme rules and module-boundary rules).

## Broken or missing, not fixed

1. **Studio Hermes chats cannot use the Gadget tools.** `gadget_*` tools only
   work in the gateway process that hosts the devices; Studio's chats run Hermes
   through its bridge, where the tools are unavailable. The card in scenario 12
   was sent through Hermes's API server (a gateway chat) instead.
2. **The `rea` plugin slows every new Hermes agent by about 60 s.** Its MCP
   server (`npx -y rea-agents@6.7.0 mcp`) kept failing to connect inside Hermes
   ("CancelledError"), although it starts in 11 s by hand. Each new chat waits
   for it. Effects: Orb's "Send to Studio" took 64 s to answer, and FAITH's first
   `studio_start` hit its 60 s timeout (Studio still made the chat twice).
3. **Orb's work prompt names a tool Hermes does not have.** It says
   `ekko_studio_use_orb_read`; in Hermes that tool sits behind
   `mcp__ekko_studio_use__ekko_studio_use_toolset`. Strong models find it; hy4-flash
   kept calling the bare name. This text comes from Orb, not Studio.
4. **`/studio` needs two Enters.** The first Enter only completes the
   suggestion. Every slash command works this way, so it was left alone.
5. **No approval before Home Assistant actions.** Turning a light on ran without
   asking. Hermes's approvals cover risky commands, not HA service calls.
6. **Gadget card says "not listening" during a restart.** For about a minute
   after Restart gateway it shows "Listening: No ... Restart the gateway to
   apply", with no "restarting" hint.
7. **Hermes chats in herdr: pane turns stay in the pane.** As documented, only
   Claude Code and Codex mirror pane turns back to Studio.
8. **First run of an agent in a fresh home.** Elevating a chat in a new install
   lands on the agent's own first-run prompts (Hermes's telemetry question;
   Claude Code's theme, "use this API key?" and folder trust). Pressing Enter
   picks "No" / "No, exit" in Claude Code, and the chat then fails with 401.
   Answering Yes fixes it.
9. **Agent work API.** The REST create takes `vikunjaTaskId` (camelCase) and
   silently drops `vikunja_task_id`; there is no delete. Ekko's record had an
   empty `sessionId` (the chat was not linked).
10. **Clean room** ran as root here because Studio ran as root; Claude Code
    inside it also reached `api.anthropic.com` (allowed by the allowlist).

Test-setup notes (not Studio bugs): Docker Hub rate-limited pulls (used
`mirror.gcr.io`); Zig could not fetch herdr's build deps through the proxy
(fetched by hand); PyPI's `hermes-agent` is old (0.19), so Hermes 0.23.4 came
from source; this cloud session's own Claude Code variables had to be removed
from Studio's environment before Claude Code would run. Before that, one failed
Claude Code run may have sent this session's account email in its prompt to
OpenRouter through Studio's gateway. Hermes's tool search was turned off in the
test profile to try the Orb tools.

## Cost

OpenRouter key usage: **$7.3021 before, $7.4001 after: $0.0980 in total**
(scenarios 1–12, 14, 15: $0.0906; scenario 13: $0.0074).
Studio's run limits were $0.10 per run and 10 minutes; the time limit stopped
one stuck chat (it showed in Mattermost).

## Screenshots

Desktop (1440×900, scale 2):

- Plugins page: ![](s1-plugins-installed.png)
- Hermes chat and approval: ![](s2-hermes-turn1.png) ![](s2-hermes-approval-asked.png) ![](s2-hermes-approval-done.png)
- Ekko approval: ![](s3-ekko-approval-asked.png)
- Claude Code via gateway: ![](s4-claude-done.png)
- Run limits: ![](s5-limit-hit.png) ![](s5-after-restart.png) ![](s5-continued.png)
- herdr: ![](s6-elevated-chat.png) ![](s6-palette.png) ![](s6-herdr-to-studio-fixed.png)
- Orb: ![](s7-orb-connected.png) ![](s7-orb-progress.png)
- Agent work: ![](s8-agentwork-settings-saved.png) ![](s8-studio-approved.png) ![](s8-orb-approved.png)
- Mattermost channel: ![](s9-mattermost-channel.png)
- Home Assistant: ![](s10-ha-done.png)
- Gadget card: ![](s12-gadget-card.png)
- Clean room: ![](s14-cleanroom-details.png)
- mcp-serve: ![](s15-coding-agent-reads-hermes-chats.png)

Phone (iPhone 13):

![](phone-hermes-chat.png) ![](phone-limit-card.png) ![](phone-herdr.png) ![](phone-cleanroom.png) ![](phone-agent-work.png)

## Round 2 (fixes)

Run on `studio-herder` 1fc2455 (with the fixes for the list above) and Pondering Orb
`studio-herder` 0bec2a3, in a fresh test home, with the same model, limits and rules.
The recommended plugins (rea included) were installed this time.

| # | Check | Result | Notes |
|---|---|---|---|
| A | rea and new chats | Pass | A second new Hermes chat reached its first tool in 12 s (8 s later); the turn started 30 ms after the request while rea kept connecting. With the docs' `config.yaml` entry for rea, rea connected (209 tools). |
| B | Home Assistant approvals | Pass | Reads ran without asking. `light.turn_on` asked "Home Assistant: light.turn_on on light.bed_light". Trust this offered `light.turn_on`; with `light.*` the next light ran without asking. After `/yolo` a switch ran without asking. |
| C | Gadget from a Studio Hermes chat | Pass after fix | "Restarting…" shows during Restart gateway (back in 15 s). The tools were hidden in Studio's chats: fixed (below). Then `gadget_devices`, `gadget_display` and `gadget_action` reached the simulated D.A.S.H; `gadget_play` said it only works in gateway chats. This Gadget version has no `gadget_speak`. |
| D | Elevate in a brand-new HOME | Pass | Claude Code opened with no theme, API-key or folder-trust question and answered from the pane. A Hermes pane did not stop on the telemetry question (`shared_metrics` set to off). |
| E | Orb "Send to Studio" | Partial | Orb got its answer in 1 s (64 s before). The prompt now names the toolset. hy4-flash used the toolset once, then called the bare `ekko_studio_use_orb_read` again; Hermes ends a run on an invalid tool call, so Orb shows it blocked. A model limit; the tool path itself works (round 1). |
| F | Agent work API | Pass | `vikunja_task_id` and `session_id` accepted; DELETE works; Ekko's record is linked to its chat. |
| G | `/yolo` first | Pass | `/yolo` as the first message, then `rm -rf junk` ran without asking. |
| H | Regression | Pass | Hermes, Ekko and Claude Code chats (above), run-limit card, clean room (self-check, `.env` warning, `example.com` blocked), watcher bell with all of them. |

### Fixed in round 2

- `f4059b2` fix(hermes): Studio's Hermes chats are offered the Gadget tools.
  The Gadget plugin's tool check (`runtime.any_active()`) is only true in the
  gateway process, so Hermes hid every `gadget_*` tool in Studio's chats ("check_fn
  available returned False") and the desk handoff from 378c7e6 never ran. The bridge
  now offers them while the gateway that holds the hub runs. Test:
  `tests/server/fixtures/hermes-bridge-gadget.py` (via `hermes-bridge-gadget.test.ts`).
  On `e2e-openrouter` on top of `studio-herder` 1fc2455, ready to merge.

Checks: `npm run build` passes; the bridge tests pass; `npm run harness:check`
reports the same 29 findings as `studio-herder` (none in these files).

### Still open

- Orb work with hy4-flash (E): small models still call the bare tool name.
- With rea's 209 tools in a chat, Hermes's tool search defers 247 tools and
  hy4-flash cannot use it; the test profile turned tool search off.
- In a herdr pane, Claude Code's resumed history shows Studio's injected context
  blocks (`<studio_task_plan_context>` and others) as part of the user's message.
- The `studio-herder` merge leaves out `e2e-reports/`, so this branch keeps the report
  on its own.

### Cost

Round 2: OpenRouter usage $7.4153 before, $7.4908 after: $0.0755. The key had also
gone up $0.0153 between the rounds, not from this session. Total for this session:
$0.098 + $0.0755 = **$0.174**, under the $1.10 stop.

### Screenshots

- B: ![](r2-b-ha-approval.png) ![](r2-b-trust-dialog.png) ![](r2-b-trusted.png) ![](r2-b-auto.png)
- C: ![](r2-c-gadget-restarting.png) ![](r2-c-gadget-chat.png) ![](r2-c-gadget-action.png)
- D: ![](r2-d-claude-elevated.png) ![](r2-d-hermes-elevated.png)
- E: ![](r2-e-orb-agents.png)
- G, H: ![](r2-g-yolo-first.png) ![](r2-h-bell.png)

## Round 3 (new features)

Run on `studio-herder` 0a14249, Pondering Orb and milaclone-mcp `studio-herder`, herdr 0.9.5
(Studio's own "Install herdr", same version as Wizard815/herdr), Hermes 0.23.4 from source.
Fresh test home, fake data only, `tencent/hy4-flash` only (Hermes goes through Studio's model
gateway to `openrouter/tencent/hy4-flash`), run limits $0.10 and 10 min. Studio ran with
`env -i` and a short variable list, so none of this cloud session's Claude/Anthropic variables
reached it; a search of the test home and logs found no account data.

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | UI skills | Pass | 10 skills in Hermes `skills/ui-skills`, Ekko, `~/.claude/skills`, `~/.agents/skills`; each Skills page shows the card. A Hermes chat building `signup.html` loaded skills with `skill_view` and named six (an Ekko chat did the same). `better-motion` deleted from Claude Code and Hermes stayed deleted after a restart ("Removed by you", 9 of 10); Hermes then got "not found" for it, and a new clean room mounted 9. |
| 2 | Paper card | Pass | MCP → Catalog → Design: "Paper (paper.design)", Sign-in, `https://mcp.paper.design`, "Add and sign in" (not clicked). |
| 3 | Orb whiteboard | Pass after fixes | A Hermes chat laid out "Garden plan" (2 columns, 3 cards), added "Water daily", marked "Build raised bed" doing, turned 2 cards into Orb tasks, asked to remove "Water daily". Orb's Ideas tab shows the board, the activity strip and the request with Approve/Reject; the agent's token gets 403 on approving it. Before the fixes hy4-flash never reached the tool (below). |
| 4 | Too many tools | Pass, one nit | With rea connected: "This chat has 243 tools… Tool search hides 227". Turn off tool search wrote `tools.tool_search.enabled: off`; the next message carried every tool (input 13.5K → 250.1K). Watcher: Info `tool_load`. Nit: after a reload the notice offers "Turn off tool search" again although it is off. |
| 5 | Context blocks in herdr | Pass, with a gap | Claude Code's session file and the elevated pane (`claude --resume`) show only the typed message; Studio's context came as a `UserPromptSubmit` hook attachment and the model used its `context_id`. Gap: a message sent from Studio's chat box after elevating is typed into the pane and gets no context, so the agent reused the old `context_id` and the task card refused it (the work itself was done). |
| 6 | Phone tools | Pass after fix | Fake adb (`FAKE0001`, a notes app with Save and Send). Closed by default (the chat got "No device is open to agents"). After "Agents can use Fake Phone": screen and screenshot ran without a question, tap Save asked, tap Send asked "Why it asks: presses "Send"" and was denied (never reached adb). Trust this offered `android:FAKE0001:com.example.notes:tap`; the next Save tap ran without asking, but so did Send: fixed (below), re-run: Save trusted, Send asked. |
| 7 | Gadget from a Studio Hermes chat | Pass | Simulated device on the gateway's port 8765; `gadget_devices`, `gadget_display` ("Dinner") and `gadget_action` (`led on`) reached it. |
| 8 | Regression | Pass | Hermes, Ekko and Claude Code chats; loop detector stopped a run (5 identical calls); `/limits tokens 2k` gave the "Run stopped by a limit" card; bell shows approvals, denials, tool load, clean-room blocks; clean room (self-check, `example.com` blocked, UI skills mounted); Elevate, pane turn mirrored back, Return to Studio. |

### Fixed in round 3

- `fed5b32` fix(hermes): Studio tools called by their own name reach their toolset.
  In Hermes, Studio's `use` tools sit behind `ekko_studio_use_toolset`; hy4-flash called
  `ekko_studio_use_orb_board` directly (also when told the exact toolset call) and Hermes ended
  the run after three unknown names. The bridge now extends Hermes's deferred-tool routing so a
  catalog tool called by its name becomes the toolset's `action=call`. Test:
  `tests/server/hermes-bridge-studio-toolsets.test.ts`.
- `93b25b9` fix(studio-mcp): a toolset call with bad arguments gets the tool's schema. After the
  routing fix, hy4-flash sent empty arguments five times (the error said "call describe first")
  until the loop detector stopped it. The error now carries the schema; the next run did all
  five board steps. Test: `tests/server/studio-mcp-arguments.test.ts`.
- `d3eb7bd` fix(android): a trust rule for ordinary taps no longer passes a Send tap. Dangerous
  actions now have their own trust value (`…:<action>:danger`); `android:<device>:*` and a rule
  made from a dangerous question still cover them. Test: `tests/server/android-phone-tools.test.ts`.
- `0d6ed6f` docs: the routing above in `docs/pondering-orb.md`.

Checks: `npm run build` passes. The tests above and the related suites pass (35 tests).
Full Vitest: 5 failures in 4 files, the same 5 on `studio-herder` (ekko-agent tools, session
titles, a plugin dev-host test, a permission test that fails as root). `npm run harness:check`:
the same 29 findings as `studio-herder`, plus this report folder.

### Broken or open, not fixed

1. **Elevated chats: no Studio context for messages sent from the chat box** (check 5). The
   task card cannot be updated in those turns. Needs a decision on how Studio hands the context
   to a pane turn it typed.
2. **Claude Code's "We're changing auto mode…" notice** held the elevated pane until Enter was
   pressed. A first-run style prompt that `first-run.ts` does not pre-answer (Claude Code
   2.1.332, this container's build). The pane's "Both CCR_OAUTH_TOKEN_FILE and
   ANTHROPIC_API_KEY set" warning also comes from this container's build, not from Studio
   (the pane's environment has no `CCR_*` variable).
3. **Tool notice after reload** offers "Turn off tool search" when it is already off (the saved
   notice keeps `toolSearch: auto`).
4. **Bell noise:** "Recommended plugin print3d was not installed" is added again on every start.
5. **hy4-flash behaviour:** in the first board attempt (before Studio's MCP was set up, see
   setup notes) the chat searched the filesystem for the tool, read Studio's database and Orb's
   address, and said it would turn tool search back on; it was stopped. It often answers or
   writes task cards in Chinese.
6. **Milaclone (not Studio):** the board's tile on Home says "2 cards" for a board with two
   columns and four cards (it counts top-level items).

Setup notes (not Studio bugs): Hermes 0.23.4 needs Python 3.14 (on 3.13 `hermes dashboard` fails
on `ruamel`, so the recommended plugins could not install); Studio finds the Hermes source from
the venv's location, so `/opt/hermes/hermes-agent` links to the source; the artifacts tool puts
test homes in `/tmp`, where Studio skips adding its MCP servers to Hermes
(`HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT=1` turns that on) and the clean room's socket
path is too long (a short symlink for `HERMES_WEB_UI_HOME` fixed it; Studio's error said so
clearly); rea needs the docs' `config.yaml` entry behind a proxy and was switched off after
check 4 to keep each call small; Orb and Milaclone ran with `node` (no Docker); the clean-room
image came from `mirror.gcr.io`.

### Cost

OpenRouter usage: **$7.4911 before, $7.6008 after: $0.1097** for round 3 (under the $0.90 stop).
The biggest single call was the first message after turning tool search off (~$0.009 with 243
tools). Total for this session's three rounds: $0.098 + $0.0755 + $0.1097 = **$0.283**.

### Screenshots

- 1: ![](r3-1-hermes-skills.png) ![](r3-1-hermes-html.png) ![](r3-1-signup-page-hermes.png) ![](r3-1-claude-removed.png)
- 2: ![](r3-2-paper-card.png)
- 3: ![](r3-3-board-chat.png) ![](r3-3-orb-ideas-board.png)
- 4: ![](r3-4-notice.png) ![](r3-4-next-msg.png)
- 5: ![](r3-5-elevated.png) ![](r3-5-pane-turn2-done.png)
- 6: ![](r3-6-open-to-agents.png) ![](r3-6-question-1.png) ![](r3-6-bell.png) ![](r3-6-trust-dialog.png) ![](r3-6-after.png)
- 7: ![](r3-7-gadget.png)
- 8: ![](r3-8-claude.png) ![](r3-8-cleanroom-egress.png) ![](r3-8-limit-hit.png) ![](r3-8-returned.png)

## Round 4 (Omi, approval alerts, web tools, import, LLM wiki, Test Lab)

Run on `studio-herder` 7e7855d in a fresh container: Hermes 0.23.4 from source (Python 3.14),
herdr 0.9.5 through Studio's own "Install herdr", Claude Code 2.1.332, Codex 0.172.0, Qwen Code
0.28.4, OpenCode 1.19.6 and Gemini CLI 0.71.1 under Node 24. Studio ran with `env -i` and a short
variable list, a fresh home outside `/tmp` (`/srv/r4`), recommended plugins off (no rea), run limits
**$0.05 and 10 minutes**. Model: `tencent/hy4-flash` only. Fake data only; every outside service was a
local fake (Omi, the phone, adb) or a throwaway container (Mattermost preview, Test Lab apps).

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Omi in Studio | Pass (approval item made by hand) | Fake Omi on :18800. Test connection "Omi answered /v1/health (ok)"; key `sk-studio-omi-…` shown once; webhook registered. A work chat started with the key ran a real Hermes turn (wrote the file); both `chat.run.completed` events reached Omi with a **valid `X-Hermes-Signature-256`**, and no other chat was sent. With the key: `/api/hermes/sessions` → 403 "This key is for Omi…"; key in the URL → 401; approving work in a chat Omi did not start → 404. Omi approved with `by: Robin` → "Approved."; Studio's reject then got "Already approved in Omi by Robin (Omi)."; Agent work shows "Done in Omi" / "approved in Omi". Revoked key → 401. MCP card: "omi is connected: 2 tools", the delete tool excluded, key in `.env`; Omi skill copied. hy4-flash did not create the Agent work item itself (it announced the tool call twice and stopped), so it was created with Studio's REST API, linked to Omi's chat. |
| 2 | Approval alerts | Pass | Settings → Watcher → **Both**, Agent work + Chat approvals + Phone actions. Fake phone paired with a code (`POST …/pair` → key), held the SSE stream (`approvals` on connect and on each change). Its key gets 403 outside its scope. A real Claude Code turn asked twice; both reached the phone live, `rm -rf …` flagged `dangerous: true`. Approved from the phone → "Approved.", again → "Already approved on phone (Pixel 8 (fake))." The Mattermost post `#approval #chatapproval @testadmin` with buttons changed to "#approved ~~#approval~~ … was approved on phone (Pixel 8 (fake))" without buttons; the folder was deleted. Removing the phone sent `revoked`, closed the stream, and the key got 401. |
| 3 | Web tools off in clean rooms | Pass (Codex inconclusive) | Claude Code, Codex, Qwen Code, OpenCode rooms: self-check "off for Claude Code (WebSearch, WebFetch)", "off for Codex (web_search)", "off for Qwen Code (web_fetch, web_search)", "off for OpenCode (webfetch, websearch)"; `example.com` refused, npm reachable. Each agent's own tool list had no web tool (outside a room Claude Code lists WebFetch/WebSearch). `allowWebTools: true` → self-check "allowed (Claude Code)", the room was made again, and Claude Code listed WebFetch and WebSearch again. Codex lists no `web_search` either way through Studio's chat-completions provider, so its switch could not be seen. Gemini CLI: `/etc/gemini-cli/settings.json` (`tools.exclude`) is mounted in every room; Studio does not run Gemini as a chat agent. |
| 4 | Studio context for elevated chats | Pass after fix | **Claude Code**: elevated, a message from Studio's chat box reached the pane as typed text only; the `UserPromptSubmit` hook gave a fresh `context_id` and both task-card calls returned `ok` ("Write bye.txt" completed). **Hermes CLI**: before the fix Studio always appended the blocks to the typed text, and they stayed in Hermes's history (fixed below). After it, Studio wrote `turn-context/hermes-<chat>.json`, the stored message was only the typed text and the model got the context, but hy4-flash then returned empty answers ("Thinking-only response") and made no tool calls, so the task card was not updated in this run. The gateway-restart gap did not come up: no Hermes gateway was running. |
| 5 | Chat import | Pass | Zip with two Hermes profiles (copies of a real `state.db`, ids rewritten), a Claude Code session, Codex and OpenClaw files, plus `.env`, `auth.json`, `.credentials.json`: preview 6 chats, "4 other files in the archive were left out"; 6 imported. Re-scan of the zip and of Studio's own home: all "Already imported". No fake credential string anywhere in Studio's data. An imported Hermes chat continued with a real turn and answered from its history ("I reported oats"). The imported Claude Code chat (no local session file) was elevated; the pane got the recap and answered "hello.txt and bye.txt". |
| 6 | LLM wiki | Pass after fix | The vault's real `llmwiki-mcp-bridge/main.js` on Express :27123 with an on-disk `obsidian` stub, over a copy without `.git`; tokens from `family-setup.mjs` (member `sam`, shared `house-assistant`). Connections → LLM wiki: "Connected as Sam (member)" and "House assistant (shared), the household's view". Before the fix recall searched Studio's tool names (below). After: profile `sam` recalled the shared "Bin Day" note and Sam's private "Piano Lessons" note; profile `household` recalled Bin Day and said the piano teacher was unknown (its search found nothing). Remember: Sam's turn wrote to `people/sam/daily/2026-11-25.md` (Worked on), the household's to `household/daily/2026-11-25.md` (Follow-ups). |
| 7 | Test Lab | Pass after fix | nginx + Vikunja via `mirror.gcr.io`, hy4-flash, cap $0.10, 10 min. The first run failed: Vikunja exited at once (fixed below). Re-run: images, network, apps, health, seed, agent, report all done; report "3 passed, 0 failed" (alice sees "Alice's secret task", bob does not, nginx page); cost $0.0003 (gateway, 33,508 tokens) / $0.0002 (OpenRouter key counter); cleanup "4 containers, 1 network". The Mattermost and clean-room containers (not Test Lab's) were left alone. |
| 8 | Regression | Pass | Hermes, Ekko and Claude Code chats (Claude asked before Bash, Allow once worked); `/limits tokens 2k` gave "Run stopped by a limit"; bell shows approvals, "Approved on phone", clean-room blocks; Elevate and Return to Studio (pane closed); UI skills (10) in Hermes, `~/.claude/skills`, `~/.agents/skills`. Phone tools with a fake adb: closed by default (Ekko: "no device is currently open to agents"); after "Agents can use Fake Phone", tap Save waited for approval and reached adb (`input tap 280 1075`) only after Allow once. |

### Fixed in round 4

- `3f135a4` fix(herdr): Hermes panes get Studio's context through the plugin. Studio decided
  whether its `studio-turn-context` plugin was on by reading its own provider config
  (`studio/public/provider-config`), which has no `plugins` section, while the plugin is enabled in
  the profile's Hermes `config.yaml`. The check was always false, so every message from Studio's chat
  box to an elevated Hermes pane carried the context blocks after the text, and Hermes kept them in
  its history. Test: `tests/server/herdr-hermes-turn-context.test.ts`. Re-run: only the typed text is
  stored.
- `445673c` fix(llm-wiki): recall from the user's words, not Studio's context blocks. In a Studio
  Hermes chat the message the provider sees ends with `<studio_task_plan_context>` and the other
  blocks; the word search took its four longest words from them (`mcp__ekko_studio_…`, the turn's
  context id), so recall never found the user's notes ("Recycling bin: unknown"). The provider now
  drops `<studio_*>` blocks before recall, the trivial check and the chat's "Worked on" line. Test:
  `tests/server/llm-wiki-provider.test.ts` (fails without the fix). Re-run: both notes recalled.
- `ed239a3` fix(test-lab): Vikunja starts. `vikunja/vikunja:2.7.1` runs as uid 1000 with a
  root-owned `/app/vikunja`; the template's `/app/vikunja/files` could not be created ("permission
  denied"), Vikunja exited, its health check failed (`EAI_AGAIN`) and the agent reported it
  unreachable. The template now sets `VIKUNJA_FILES_BASEPATH=/tmp/vikunja` with the database inside.
  Test: `tests/server/test-lab-templates.test.ts`. Re-run passed.

Checks: `npm run build` passes. The touched suites pass (7 files, 73 tests: herdr turn context and
bridge, LLM wiki provider and settings, Test Lab templates and service). `npm run harness:check`: the
same 29 findings as `studio-herder`, plus this report folder.

### Broken or open

The first three were fixed afterwards (next section).

1. ~~**hy4-flash stops before tool calls.**~~ Fixed in Studio (`2a82c54`, `409a419`).
2. ~~**Phone questions from Ekko are not linked to the chat.**~~ Fixed (`4d60d9e`).
3. ~~**Coding agents that are not installed say "Node/npm environment was not detected"**~~ Fixed (`71651b5`).
4. **Codex's web switch can't be seen through Studio's provider**: Codex offers no `web_search` on a
   chat-completions provider, with the switch on or off.
5. Clean rooms ran as root (Studio ran as root here), as in round 1.
6. **Hermes's Agent work and phone calls carry no chat id** (found while re-testing): Hermes's
   Studio MCP process is shared by its chats, so an item a Hermes chat creates has an empty
   `sessionId` (already listed under Limits in `docs/android-devices.md`). Ekko's are linked.

### Follow-up fixes (2026-11-26)

Re-tested live on a fresh Studio (same rules: hy4-flash only, $0.05 per run, fake adb).

- `71651b5` fix(coding-agents): a missing agent says it is not installed, not that Node is missing.
  `isNodeEnvironmentMissingError` read any `ENOENT` (`spawn kimi ENOENT`) as a missing Node. Now only
  a missing `node`/`npm` counts. Test: `tests/server/coding-agent-status-missing.test.ts` (fails
  without the fix). Live: "Kimi Code is not installed", "CodeBuddy is not installed", ...
- `4d60d9e` fix(android): a phone question belongs to the chat that asked. Ekko's phone tool sends
  no `sessionId`; the agent route now takes the chat from the run's credential (`runBinding`, as
  Agent work does). Test: `tests/server/android-agent-run-binding.test.ts`. Live: the Ekko tap
  question and its bell alert carry the Ekko chat's id.
- `2a82c54` and `409a419` fix(hermes): small models reach Studio's tools in Studio's Hermes chats.
  Three causes, each confirmed live:
  - Hermes's tool search hides every MCP tool (a stock chat: 29 tools, 13 hidden, under the 80-tool
    notice threshold), so Studio's toolsets sat behind `tool_search` → `tool_describe` →
    `tool_call`. With tool search off by hand the same prompt worked. The bridge now keeps
    `mcp__ekko_studio_*` tools visible; other MCP servers stay behind tool search.
  - Hermes's re-prompt for "I'll find the tool…" with no tool call
    (`agent.intent_ack_continuation`) is off outside Codex providers; the bridge turns it on unless
    the profile sets it. Live it fired twice ("[System: Continue now…]") on the old toolset layout.
  - Hermes's stall guard misses "Now let me discover the tool." and "…; locating it now." after a
    tool result; the bridge widens it, within Hermes's 400-character and two-nudge limits.
  Tests: `tests/server/hermes-bridge-turn-guards.test.ts`, `hermes-bridge-studio-toolsets.test.ts`
  (both checked against Hermes 0.23.4's own `classify_tools` and `trailing_continue_intent`).
  Live, the round-4 phone prompt in a Hermes chat: **0 of 3 runs with the two patches switched off,
  4 of 4 with them** (each read "Save" and "Send" from the fake phone). The Omi prompt (write a file,
  then create Agent work) worked 2 of 2 (round 4: 0 of 1).
  Note: Hermes's self-improvement had written a skill in the test home from the earlier runs
  (`skills/studio-device-interaction`) describing the old `tool_search` path; it was deleted before
  the comparison runs, since a fresh install doesn't have it. `docs/hermes-tool-load.md` says so.

Checks: `npm run build` passes; the touched and related suites pass (9 files, 47 tests);
`npm run harness:check` has the same 30 findings as before (29 on `studio-herder` plus this report
folder). Cost of the follow-up: $12.1018 before, $12.1399 after: **$0.0381** (the key had gone up
about $0.67 overnight from other use). Round 4 in total: $0.0423 + $0.0381 = **$0.080**.

Setup notes (not Studio bugs): Node 22 made the client warn "upgrade to version 23", so Studio
ran on Node 24 (`npm rebuild node-pty`); npm 11 skips install scripts unless allowed, so Claude Code
and OpenCode needed `--allow-scripts`; Studio's new-chat form keeps its own profile choice (chat
settings icon), not the active profile; the test home's `config.yaml` triggers block deleting
sessions from a copied `state.db` (dropped in the copy for the import fixture). Two screenshots that
showed the (fake, revoked) Omi key and webhook secret were left out.

### Cost

OpenRouter key usage: **$11.3885 before, $11.4308 after: $0.0423** for round 4 (stop at $0.45,
budget $0.50). The key had gone up about $3.79 between rounds 3 and 4, not from this session.
Total for this session's four rounds: $0.098 + $0.0755 + $0.1097 + $0.0423 = **$0.325** (plus $0.0381 for the follow-up fixes: **$0.363**).

### Screenshots

- 1: ![](r4-1-omi-connected.png) ![](r4-1-omi-chat.png) ![](r4-1-agentwork-done-in-omi.png) ![](r4-1-omi-work.png) ![](r4-1-omi-mcp.png)
- 2: ![](r4-2-watcher-both.png) ![](r4-2-pairing-code.png) ![](r4-2-claude-asks.png) ![](r4-2-mattermost-approved-on-phone.png) ![](r4-2-claude-after-phone.png)
- 3: ![](r4-3-claude-room.png) ![](r4-3-codex-room.png) ![](r4-3-qwencode-room.png) ![](r4-3-opencode-room.png) ![](r4-3-claude-web-on.png) ![](r4-3-codex-web-on.png)
- 4: ![](r4-4-claude-elevated.png) ![](r4-4-claude-taskcard.png) ![](r4-4-hermes-elevated.png) ![](r4-4-hermes-sent.png)
- 5: ![](r4-5-import-preview.png) ![](r4-5-import-done.png) ![](r4-5-import-studio-home.png) ![](r4-5-imported-hermes-continued.png) ![](r4-5-imported-claude-elevated.png) ![](r4-5-imported-claude-asked.png)
- 6: ![](r4-6-wiki-sam.png) ![](r4-6-wiki-household.png) ![](r4-6-sam-recall.png) ![](r4-6-household-recall.png) ![](r4-6-sam-remember.png) ![](r4-6-household-remember.png)
- 7: ![](r4-7-testlab-new-run.png) ![](r4-7-testlab-report.png)
- 8: ![](r4-8-hermes.png) ![](r4-8-ekko.png) ![](r4-8-claude.png) ![](r4-8-claude-done.png) ![](r4-8-limit-hit.png) ![](r4-8-bell.png) ![](r4-8-returned.png) ![](r4-8-phone-closed.png) ![](r4-8-phone-open.png) ![](r4-8-phone-tap.png) ![](r4-8-phone-allowed.png)
