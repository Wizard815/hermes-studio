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
- **Network:** `internet` (Docker's default bridge: the internet, but none of
  Studio's own networks) or `none`.
- **Limits:** 4 GB memory and 2 CPUs by default (up to 32 GB and 16), 4096
  processes, `no-new-privileges`, no host folders and no Docker socket. At
  most 8 run at once.
- **Lifetime:** 60 minutes by default, 5 minutes to 24 hours, and `extend`
  adds more. Studio checks every minute and removes the ones whose time is up.
  It only ever removes containers labelled with its own instance id.

Images from Docker Hub are pulled through `mirror.gcr.io` first (Docker Hub
limits pulls), then from Docker Hub.

## Actions

| Action | Fields |
| --- | --- |
| list | The sandboxes and the distro presets |
| create | `distro` or `image`, `network`, `minutes`, `memoryGb`, `cpus`, `purpose` |
| exec | `sandbox`, `command` (run with `sh -c`), `workdir` (default `/work`), `timeoutSeconds` (default 300, up to 3600). Returns `exitCode`, `timedOut` and the last 64 KB of output |
| write_file / read_file | `sandbox`, `path` (absolute), `content` (up to 1 MB) |
| copy_repo | `sandbox`, `repo` (GitHub or forge git URL), `ref`. Cloned on the Studio machine with its own GitHub or forge login, copied to `/work/NAME`. The token never goes into the sandbox |
| extend | `sandbox`, `minutes` |
| remove | `sandbox` |

The HTTP routes are `GET /api/studio/sandbox`, `DELETE /api/studio/sandbox/:id`
and `POST /api/studio/sandbox/tool/:action`, super admins only.

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
- **"8 sandboxes are running already"**: remove some on the Test Lab page.
- **A command ends with exit code 137 and `timedOut: true`**: it ran longer
  than `timeoutSeconds`. Images without `timeout` (rare) are not cut off, so
  the call waits up to the limit plus 15 seconds.
- **Nothing installs with `network: none`**: that's the point. Make it with
  `internet` instead.
