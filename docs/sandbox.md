# Sandboxes

Throwaway Linux containers on the Studio machine. An agent makes one when a
clean or different system helps: trying installs without clutter, running a
build on another distro, reproducing a bug from scratch, or running code it
doesn't trust yet. The model decides when to use one; nothing is gated.

The agent tool is `ekko_studio_use_sandbox` (toolset `use`). The page is Test
Lab → Sandboxes, which lists them and has Remove. The bundled `sandbox` skill
tells agents when to reach for one.

## What a sandbox is

A plain Docker container from an image, kept alive until it is removed.

- **Distro presets:** ubuntu (24.04), debian (13 slim), fedora (43), rocky (9,
  RHEL-like), alpine (3.22), arch, opensuse (Leap 15.6), node (24), python
  (3.13), go (1.25). Any other image works by name (`image: "nixos/nix"`).
- **Network:** `internet` (only through Studio's proxy, see below) or `none`.
- **Limits:** 4 GB memory and 2 CPUs by default (up to 32 GB and 16), 4096
  processes, `no-new-privileges`, no host folders and no Docker socket. At
  most 8 run at once.
- **Lifetime:** 60 minutes by default, 5 minutes to 24 hours, and `extend`
  adds more. Studio checks every minute and removes the ones whose time is up.
  It only ever removes containers labelled with its own instance id.

Images from Docker Hub are pulled through `mirror.gcr.io` first (Docker Hub
limits pulls), then from Docker Hub.

## Internet goes through a proxy

A sandbox with `internet` sits on an internal Docker network with no gateway.
It cannot reach your LAN, Unraid, Studio or the internet directly, and it gets
no DNS. Its only way out is a Squid proxy (`studio-sandbox-egress-…`, one per
Studio). `HTTP_PROXY` and `HTTPS_PROXY` are set in every sandbox, so curl,
wget, pip, npm, apt, apk, dnf, git and go use it. Anything that ignores them
fails.

The proxy:

- **Refuses private addresses always**, in every mode: 10/8, 172.16/12,
  192.168/16, 127/8, 100.64/10, link-local, IPv6 private ranges. It checks the
  address after DNS, so a public name that points at your LAN is refused too.
- **Allows only ports 80 and 443.**
- **Checks the host name** against the rules, set on Test Lab → **Internet for
  sandboxes**:
  - **Only the allowed sites** (the default). Each name covers its
    subdomains. The default list covers downloads for:
    - JavaScript: npm, Yarn, pnpm, Bun, Deno, JSR, unpkg, jsDelivr, esm.sh,
      cdnjs.
    - Python, Rust, Go, Java and Gradle, Ruby, PHP, Elixir, Haskell, Dart,
      Perl and R.
    - Windows and .NET: NuGet, the .NET SDK, Microsoft downloads, PowerShell
      Gallery, Chocolatey, winget, Scoop, MSYS2, Wine, SourceForge.
    - Linux: Debian, Ubuntu, Alpine, Fedora, Rocky, Alma, CentOS, Arch,
      openSUSE, Gentoo, Void, Mint, Nix, Flathub, Snap, Homebrew, kernel.org,
      GNU.
    - Docker Hub, Quay, GHCR, Kubernetes, HashiCorp, CMake and LLVM.
    - GitHub, GitLab, Bitbucket and Codeberg.
    - Steam and SteamCMD downloads.

    Catch-all hosting (Google Cloud Storage, S3, Akamai) is left out, because
    anyone can put a bucket there and receive data. **Use the default lists**
    brings back the defaults after you saved your own, including sites added
    in later Studio versions.
  - **Any site except the blocked ones.** The default block list has the AI
    APIs and model hubs: OpenAI, Anthropic, Hugging Face, OpenRouter, Google
    AI, Mistral, Groq, Together, DeepSeek, xAI, Cohere, Perplexity, Fireworks,
    Replicate, Ollama.
  - **Any public site (log only).**
- **Logs every call**: time, sandbox, method, host, port, allowed or refused,
  and bytes each way. Test Lab shows the latest, with a filter for refused
  ones. Studio keeps them in `<Studio home>/sandbox/egress.jsonl` (5 MB, then
  the older half is dropped). Agents read them with `network_log`.

**Sites one sandbox needs.** When a task needs a site that isn't on the list,
for example a LegendKeeper MCP server that talks to legendkeeper.com, the agent
passes `allow: ["legendkeeper.com"]` when it creates the sandbox. Only that
sandbox gets them, only in allowlist mode, and the Sandboxes card shows them.
They are taken back when the sandbox is removed. A site on the block list is
refused, and the agent is told to ask you.

New rules reach the running proxy at once. The rules are in
`<Studio home>/sandbox/egress.json`.

What it can't see: HTTPS hides what is inside a call, so the log says
"sandbox X → pypi.org, 40 KB in" but not which file. A download and an upload
to an allowed site look the same, which is why the allowlist is the default.

## Actions

| Action | Fields |
| --- | --- |
| list | The sandboxes and the distro presets |
| create | `distro` or `image`, `network`, `minutes`, `memoryGb`, `cpus`, `purpose`, `allow` (extra sites for this sandbox) |
| exec | `sandbox`, `command` (run with `sh -c`), `workdir` (default `/work`), `timeoutSeconds` (default 300, up to 3600). Returns `exitCode`, `timedOut` and the last 64 KB of output |
| write_file / read_file | `sandbox`, `path` (absolute), `content` (up to 1 MB) |
| copy_repo | `sandbox`, `repo` (GitHub or forge git URL), `ref`. Cloned on the Studio machine with its own GitHub or forge login, copied to `/work/NAME`. The token never goes into the sandbox |
| extend | `sandbox`, `minutes` |
| remove | `sandbox` |
| network_log | `sandbox` (optional), `blocked: true` for refused calls only, `limit`. Returns the calls, newest first, and the proxy's rules |

The HTTP routes are `GET /api/studio/sandbox`, `DELETE /api/studio/sandbox/:id`,
`POST /api/studio/sandbox/tool/:action`, `GET`/`PUT /api/studio/sandbox/egress`
(the rules) and `GET /api/studio/sandbox/network-log?sandbox=&blocked=1&limit=`,
super admins only.

## Setup

Sandboxes and Test Lab run on a Docker of Studio's own, the `sandbox-docker`
sidecar in `docker-compose.yml`. Studio reaches it through
`STUDIO_SANDBOX_DOCKER_HOST=unix:///run/sandbox-docker/docker.sock`.

Do not give them the host's `/var/run/docker.sock`. Agents run shell commands
in Studio's container, so they can reach any Docker Studio can. With the host's
socket, an agent can start a privileged container and take over the host. The
sidecar holds only sandboxes, and it is rootless: even a `--privileged`
container started in it is an unprivileged user on the host. It needs
`/dev/net/tun` (Unraid has it).

Without `STUDIO_SANDBOX_DOCKER_HOST`, sandboxes fall back to the System page's
Docker (`DOCKER_HOST`, then `/var/run/docker.sock`).

The list of sandboxes is in `<Studio home>/sandbox/sandboxes.json`.

## Sandboxes or forge runners

A sandbox runs on the Studio machine and has no GPU. For GPU work, or to run
something on your own Forgejo runners like CI, Hermes uses the `forgejo`
skill: `job run --runner gpu -- COMMAND` or `--runner ubuntu-latest`. See
[forge](forge.md).

## What goes wrong

- **"Docker is not reachable"**: start the `sandbox-docker` sidecar (above)
  and check `STUDIO_SANDBOX_DOCKER_HOST`. `docker logs` on the sidecar that
  says `tap0` failed means `/dev/net/tun` is missing.
- **A Test Lab run can't write its results in the rootless sidecar**: the run
  folder belongs to root. Use `image: docker:28-dind` for the sidecar instead.
  That keeps agents away from the host's containers, but a privileged container
  in it can still reach the host.
- **"Could not pull IMAGE"**: the name is wrong, or the machine can't reach
  `mirror.gcr.io` or Docker Hub.
- **An install fails with `403` or `CONNECT tunnel failed`**: the host isn't
  allowed. The refused calls on Test Lab name it: add it to the allowed sites.
  Distros that pick a mirror at random (Fedora, openSUSE, Arch) can land on one
  that isn't listed.
- **busybox `wget` fails on https** ("error getting response"): it can't send
  https through a proxy. Use curl (`apk add curl`).
- **SteamCMD logs in but stalls**: Steam's own servers may want ports other
  than 80 and 443, which the proxy doesn't pass. Downloads over https work.
- **A clone from your own forge fails inside the sandbox**: the forge is on the
  LAN, which is always refused. Use `copy_repo`, which clones on the Studio
  machine.
- **The proxy image can't be pulled**: the first sandbox with internet pulls
  `ubuntu/squid` through the mirror. Offline sandboxes don't need it.
- **"8 sandboxes are running already"**: remove some on the Test Lab page.
- **A command ends with exit code 137 and `timedOut: true`**: it ran longer
  than `timeoutSeconds`. Images without `timeout` (rare) are not cut off, so
  the call waits up to the limit plus 15 seconds.
- **Nothing installs with `network: none`**: that's the point. Make it with
  `internet` instead.
