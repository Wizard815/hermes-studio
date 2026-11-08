# System page

The **System** page (pulse icon in the navigation rail, super admins only) is a
small btop for the machine that runs the Studio **server**: the desktop app's
own computer, or your Unraid/Docker host.

- **CPU:** total use with a two-minute history (hover for a sample), and every core.
- **Memory:** used and total, swap, and each real disk.
- **Network:** total received and sent per second with history, and each interface.
- **Processes:** sorted by CPU (click a header to sort by PID, name or memory),
  filtered by name, command, PID or user. **End** asks a process to quit
  (SIGTERM); **Kill** stops it immediately (SIGKILL). Studio's own server and
  init cannot be ended from here.
- **Docker:** every container with its state, image, status and published
  ports; start, stop, restart, and the last 200 log lines.

It samples every 2 seconds while the page is open and visible, and **Pause**
stops it. Several open pages share one sample.

## Desktop app

Works as is on Linux, Windows and macOS. Docker appears when Docker Engine or
Docker Desktop is running (`/var/run/docker.sock`, Windows'
`\\.\pipe\docker_engine`, or a `unix://` / `npipe://` `DOCKER_HOST`).

## Unraid / Docker

A container only sees itself by default. Two opt-in lines in
`docker-compose.yml` (or the Unraid template) widen that:

- `pid: host` (Unraid: *Extra Parameters* `--pid=host`): the Processes list
  shows the server's processes, not only the container's.
- `/var/run/docker.sock:/var/run/docker.sock`: the Docker list shows and
  controls Unraid's containers.

Both give Studio's super admins control of the whole server: ending any process
it can signal, and starting or stopping any container. Only enable them on a
Studio you alone administer.

Remote engines over `tcp://` are not supported: they need TLS client
certificates Studio does not keep.
