# Your own Git forge (Forgejo or Gitea)

Studio works with repos on the homelab's own Forgejo or Gitea as well as
GitHub. Each project picks where its threads push and open pull requests.
The board shows live status for forge PRs, and the Inbox lists forge review
requests and failed CI.

The Unraid compose for the forge is in the Overseer repo, `deploy/forgejo/`.

## Set it up

On the Studio host, set:

```bash
FORGE_URL=http://192.168.20.5:3030     # the forge as this machine reaches it
FORGE_TOKEN=...                        # forge token: read:repository, read:issue, read:user
FORGE_HOSTS=forgejo:3000               # optional: other addresses of the same forge
```

Make the token on the forge under **Settings > Applications > Access tokens**.
Studio sends it only to the forge's addresses, never to GitHub.

## What it does

| Where | With the forge |
|---|---|
| New project, **Repo URL** | A forge URL clones with `FORGE_TOKEN`, so private repos work. Plain `http://` is allowed for the forge only. A project made from a forge URL starts with **Where code goes: Home forge**. |
| Project form, **Where code goes** | **Follow the repo** (default) tells agents nothing extra. **GitHub** or **Home forge (private)** adds one line to the coordinator's and every thread's prompt, saying where to push and open PRs. Home forge also tells them to keep the work off GitHub. |
| Board | Forge PR links (`http://<forge>/<owner>/<repo>/pulls/<n>`) show state, checks (from the commit status Forgejo Actions writes) and conflicts. |
| Command Center Inbox | Forge review requests and your own open forge PRs with failed checks. Failed Actions runs are listed for repos written `forge:owner/repo` in **GitHub settings > Watch repositories** (pasting the full forge URL works too). It shows even when `gh` isn't installed. |

Agents push with their own tools. Hermes uses its `forgejo` skill. Other
agents need a git credential for the forge on the Studio host.

## What goes wrong

- **Board shows "?" on a forge PR.** Hover it. "no such item" means the link
  is wrong or `FORGE_TOKEN` can't see the repo. "refused" means the token
  expired.
- **Inbox says "Forge: The forge at ... isn't answering".** The forgejo
  container is down, or `FORGE_URL` is not reachable from the Studio host.
- **Clone fails with 401.** `FORGE_TOKEN` is missing or lacks `read:repository`.
- **A forge link is treated as "not GitHub".** Its host isn't `FORGE_URL`'s
  host and port, or in `FORGE_HOSTS`.
