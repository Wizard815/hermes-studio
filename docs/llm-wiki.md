# LLM wiki

Studio connects Hermes to the family's LLM wiki
([Wizard815/LLM-will-remember-this](https://github.com/Wizard815/LLM-will-remember-this)):
an Obsidian vault whose **LLMWIKI MCP Bridge** plugin serves a family MCP server
at `<wiki>/family-mcp`, on the Local REST API plugin's port (27123 by default).
The wiki is optional. It works two ways:

- **Hermes memory provider "LLM wiki"** (Connections → LLM wiki). Per Hermes
  profile. Recall before each turn, remember into today's daily note.
- **MCP page → Your home → LLM wiki (Obsidian)**. The wiki's tools for any
  agent that uses the profile's MCP servers.

## Privacy comes from the token

Each wiki token belongs to one family member, a shared agent or a service
(`node scripts/family-setup.mjs token <id>` in the vault; only its hash is
kept there). The wiki decides what a token can see:

- A member's token sees that person's own folder (`people/<id>/`, shown as the
  vault root) and `household/`.
- A shared token (`add-shared`, the household's assistant) sees only
  `household/` and what members share in their profile. It must name whose
  memory it writes; the provider writes to `household` unless told otherwise.
- The master key reads everyone's notes. Never give it to Hermes.

Studio never filters notes by prompt. Give a person's profile that person's
token. Give a shared profile (the family chat, a kitchen speaker) the household
token. A household token cannot read a private note, whatever the model asks.

## Connections → LLM wiki

Super admins only. One row per Hermes profile, then the selected profile:

- **Wiki's address**: for example `http://wiki.lan:27123`. A pasted
  `.../family-mcp` is trimmed. Saved in the profile's `config.yaml` as
  `memory.llm_wiki.url`.
- **This profile's wiki token**: saved in the profile's `.env` as
  `LLM_WIKI_TOKEN`. Studio never sends it back; the field then says "Saved".
  **Forget token** removes it (and turns the provider off).
- **Test connection** asks the wiki `whoami` with the form's token, or the
  saved one, and says whose view it is ("Sam's own notes and the household's",
  "the household's view", "master key: don't use it"). Wrong token: "The wiki
  refused this token". Wrong port or the plugin off: "The wiki has no
  /family-mcp at ...".
- **Use as this profile's memory** installs the provider into
  `<profile>/plugins/llm_wiki/` and sets `memory.provider: llm_wiki`. It needs
  an address and a token first.
- **Recall** and **Remember** (both on by default):
  `memory.llm_wiki.recall` / `memory.llm_wiki.remember`.

Hermes runs **one external memory provider at a time**; its built-in memory
(MEMORY.md / USER.md) always stays on. Turning the wiki on replaces the
profile's provider (Honcho, RetainDB, ...) and keeps its name in
`memory.llm_wiki.previous_provider`. Turning it off puts that one back, or
leaves only the built-in memory. Changes apply to new chats; open chats keep
the memory they started with.

API: `GET /api/studio/llm-wiki`, `PUT /api/studio/llm-wiki/profiles/:profile`
(`url`, `token`, `clearToken`, `enabled`, `recall`, `remember`),
`POST /api/studio/llm-wiki/profiles/:profile/test` (`url?`, `token?`).
Code: `modules/studio/services/llm-wiki/`.

## What the provider does

The provider is `packages/server/src/assets/hermes-plugins/llm_wiki/`
(copied to `dist/server/assets/` by the build). Studio rewrites the profile's
copy each time it is turned on.

- **Token**: read from the profile's own `.env` first, then Hermes's scoped
  secret, so a profile never borrows another profile's token.
- **Recall** (before each turn, not for "ok", "thanks" or slash commands):
  `query_wiki` (semantic search, needs the vault's Second Brain extension);
  without it, `notes_search` on the message's four longest words, notes that
  match more words first, `raw/` and `schema/` left out. The first turn of a
  chat also gets `context_for` (profile, today's daily note, open follow-ups).
  The block is at most 4000 characters, inside `<llm_wiki_memory>`, marked as
  background, not instructions.
- **Remember** (only the main agent; subagents, cron runs and memory flushes
  only read):
  - Hermes's own memory writes (`memory add`) go to today's daily note under
    "Decisions / facts worth keeping".
  - When a chat ends, one line under "Worked on": "Chat with Hermes: <first
    message>".
  - Tools for the model: `llm_wiki_search`, `llm_wiki_read`,
    `llm_wiki_remember` (one line, section `worked_on`, `decisions` or
    `follow_ups`) and `llm_wiki_capture` (a topic note in `inbox/`). A shared
    token's tools also take `person`.
  - Everything goes to the short-term tier (daily note, inbox). The wiki's
    Ingest files it into `wiki/` later. The wiki refuses anything that looks
    like a secret; the tool then answers with the wiki's error.

## MCP page → Your home → LLM wiki (Obsidian)

**Connect**: the wiki's address (a bare host gets port 27123) and a token.
Studio adds to the profile the MCP page edits:

```yaml
mcp_servers:
  llm-wiki:
    url: http://wiki.lan:27123/family-mcp
    headers:
      Authorization: Bearer ${MCP_LLM_WIKI_API_KEY}
    timeout: 120
    connect_timeout: 30
    tools:
      exclude: [memory_rollover]
      resources: false
      prompts: false
```

The token goes to the profile's `.env` as `MCP_LLM_WIKI_API_KEY` and is not
shown again. `memory_rollover` (the admin's daily filing job) is left out.
The same rule holds: use the token of the person the profile belongs to.

## Testing

- `tests/server/llm-wiki-provider.test.ts`: the provider, driven as Hermes
  drives it, against `tests/fixtures/llm-wiki/stub-wiki.cjs` (a tiny family MCP
  server with the wiki's visibility rule): token per profile, recall with the
  word-search fallback, remember, a household token that cannot see a private
  note, subagents that only read.
- `tests/server/llm-wiki-settings.test.ts`: the settings service (token in
  `.env`, provider switch and restore, test via `whoami`).
- `tests/client/llm-wiki-client.test.ts`, `tests/e2e/llm-wiki.spec.ts`: the
  MCP card's config, messages in every locale, the settings screen.
- Against the real plugin without Obsidian: load the vault's
  `.obsidian/plugins/llmwiki-mcp-bridge/main.js` with a stub `obsidian` module
  (on-disk `vault.read/create/modify/process/getMarkdownFiles`, frontmatter
  from `schema/family.md`, `loadData` from the plugin's `data.json`) and call
  its `registerFamilyRoutes()` on an Express app on port 27123. Issue tokens
  with `scripts/family-setup.mjs` on a copy of the vault, never the real one.
  Then load the provider with Hermes's own loader
  (`plugins.memory.load_memory_provider("llm_wiki")`) under a test
  `HERMES_HOME`.

## Not done

- Studio's own agents (Ekko, coding agents) do not use the provider; they can
  use the MCP card.
- Recall is synchronous with a 5 s timeout per wiki call (up to six calls on a first turn); a slow wiki slows
  the turn's start.
- The older Agent work digest (`services/agent-work/wiki.ts`) still writes
  through the Local REST API with its own key; it does not use these tokens.
