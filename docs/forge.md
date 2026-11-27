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
FORGE_DEFAULT_HOME=forge               # optional: new projects with no repo start on the forge
```

Or set nothing on the Studio host: without `FORGE_URL`, Studio uses the
active Hermes profile's forgejo skill settings (`skills.config.forgejo.url`
and `forgejo.default_home` in `config.yaml`, `FORGE_TOKEN` and `FORGE_HOSTS`
in the profile's `.env`), read again every minute. Then one setting serves
Hermes and Studio. `FORGE_URL` on the host wins when both are set.

Make the token on the forge under **Settings > Applications > Access tokens**.
Studio sends it only to the forge's addresses, never to GitHub.

## What it does

| Where | With the forge |
|---|---|
| New project, **Repo URL** | A forge URL clones with `FORGE_TOKEN`, so private repos work. Plain `http://` is allowed for the forge only. A project made from a forge URL starts with **Where code goes: Home forge**. |
| Project form, **Where code goes** | Left on **Follow the repo** for a new project with no repo, it becomes **Home forge** when the default home is `forge`. **Follow the repo** tells agents nothing extra. **GitHub** or **Home forge (private)** adds one line to the coordinator's and every thread's prompt, saying where to push and open PRs. Home forge also tells them to keep the work off GitHub. |
| Board | Forge PR links (`http://<forge>/<owner>/<repo>/pulls/<n>`) show state, checks (from the commit status Forgejo Actions writes) and conflicts. |
| Test Lab | An app built from git can use a forge repo (`http://<forge>/<owner>/<repo>.git#branch`). Studio clones it with `FORGE_TOKEN` and sends Docker the files, so private repos build and Docker never sees the token. |
| Sandboxes | `copy_repo` clones a forge repo with `FORGE_TOKEN` (GitHub repos with the GitHub login) and copies the files in. See [sandbox](sandbox.md). |
| Add a repo (chat) | Lists your forge repos and clones them with the token ([repo-pack.md](repo-pack.md)). |
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
- **Test Lab: "Could not clone ... from the forge".** The same token problem,
  or the branch after `#` doesn't exist.
- **A forge link is treated as "not GitHub".** Its host isn't `FORGE_URL`'s
  host and port, or in `FORGE_HOSTS`.
