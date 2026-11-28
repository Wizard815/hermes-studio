# MCP directory

The MCP page has a **Directory** tab next to Catalog. It works like a connector
picker: browse MCP servers, then add one or hand it to Hermes to set up.

## Recommended

Three servers with a pinned config that the [homelab skills](homelab-skills.md)
know how to use:

| Server | Runs | Needs on the Hermes host |
| --- | --- | --- |
| tokensave | `tokensave serve` | the tokensave binary (`cargo install tokensave --version 7.16.0`), and `tokensave init` in each repo |
| markitdown | `uvx markitdown-mcp==0.0.1a8` | `uv` |
| repomix | `npx -y repomix@1.19.0 --mcp` | Node.js 18+ |

**Add** shows the command and adds the server to the active Hermes profile.

## Community list

Every server in [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
(MIT), about 5,000 of them. Studio downloads the list's README on the server,
keeps it for a day in `<HERMES_WEB_UI_HOME>/mcp-directory/`, and searches it there.
Filter by category, local or cloud, official, and **Ready to add**.

- **Set up with Hermes** opens a new chat with a setup request in the composer.
  Hermes reads the server's README, says what it needs and does, and asks
  before installing. Nothing is sent until you press Send.
- **Add** appears only when the list gives a plain `npx` or `uvx` line. The
  dialog warns that nobody reviewed the server: Hermes will run that command on
  its host with your user's access. Lines that set something up (`setup`,
  `install`, `login`) or use shell pipes are shown, never added.

API: `GET /api/hermes/mcp/directory?q=&category=&scope=local|cloud&official=1&ready=1&offset=&limit=&refresh=1`.

## What goes wrong

- **"Could not download the MCP list from GitHub".** The Studio host cannot
  reach raw.githubusercontent.com and has no cached copy yet. With a cached
  copy, Studio uses it and logs a warning.
- **An added server shows no tools.** The command is missing on the Hermes host
  (`npx`, `uvx`, `tokensave`). Test it on the Servers tab; its error says which.
- **A name is taken.** Pick another name in the Add dialog; Studio never
  replaces a server you already have.
