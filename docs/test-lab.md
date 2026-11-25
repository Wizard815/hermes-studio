# Test Lab

Test Lab starts a throwaway set of apps in Docker, fills them with test data,
lets one agent test them through a browser and their APIs on one model you
pick, and writes a report. Then it removes the containers. Super admins only:
nav rail → flask icon, or `/test-lab`. (A saved navigation list does not get
the new entry by itself: add it in the navigation settings.)

## What you see

- **New run**: one model from Studio's providers (the model list of your
  current profile), the apps to start, what the agent should test, a spending
  cap (default $0.50), a time limit (default 20 minutes), "Give the agent a
  browser" (on) and "Keep the containers running after the run" (off).
  Apps built from git show a box for their git address.
- **Runs**: every run with its result, apps, model, cost and "containers still
  running" when it was kept.
- **A run**: the steps (images, private network, apps, health checks, test
  data, agent test, report, clean up) with their state in words; each app with
  its state, address on the lab network, logins and log tail; the cost; the
  report (summary and PASS / FAIL / SKIP per check); screenshots (click to
  enlarge); the agent's transcript. Buttons: **Stop**, **Remove containers**
  (a kept run), **Download zip** (run.json, report.md, report.json,
  progress.jsonl, screenshots, logs).
- **Settings** (on the page): registry mirror, runner image, browser image,
  default cap and minutes, agent steps.
- **No Docker**: the page only says to mount `/var/run/docker.sock` and what
  that permits (full control of Docker on the host). Nothing else runs.

One run at a time.

## How a run works

1. **Images.** Each app's pinned image is pulled; Docker Hub images go through
   the mirror (default `mirror.gcr.io`), then Docker Hub if the mirror fails.
   Other registries (ghcr.io) are pulled as they are. Apps without an image are
   built with Docker's own git build (`POST /build?remote=…`); without a git
   address they are skipped with a message. The runner image
   (`node:24-bookworm-slim`) and the browser image
   (`chromedp/headless-shell:157.0.8103.27`) come the same way.
2. **Network.** `studio-testlab-<run>`, a Docker bridge network with
   `Internal: true`: the apps reach each other by name (`http://vikunja:3456`),
   never the internet or the host's LAN.
3. **Apps.** One container per app (`studio-testlab-<run>-<app>`), no ports
   published, memory, CPU and process limits, `no-new-privileges`. A headless
   Chrome as `browser:9222`.
4. **Runner.** One more container (`…-runner`): read-only root, all Linux
   capabilities dropped, user 1000, `/tmp` a small tmpfs, the lab network only.
   It gets `/lab/runner.mjs` (read-only), `/out` (its results) and a Unix
   socket to Studio's model gateway. It waits for each app's health check,
   runs the app's seed steps (test users and data through the app's API),
   takes a picture of each app, then runs the agent: a tool loop on the pinned
   model with `browser_open`, `browser_snapshot`, `browser_click`,
   `browser_type`, `browser_screenshot`, `http_request` (the apps' addresses
   only) and `report`. The apps' addresses and logins are in its prompt with
   your instructions.
5. **Report.** The agent's `report` call becomes `report.md` in a fixed format
   (below). Without one (stopped, out of steps, model unreachable) the runner
   writes a report with one FAIL that says why.
6. **Clean up.** Logs (last 300 lines of each container) are saved, then the
   run's containers (with their anonymous volumes), network, labelled volumes
   and built images are removed, unless "keep running" is on; then
   **Remove containers** does it later.

Everything lives under `HERMES_WEB_UI_HOME/test-lab/`: `settings.json`,
`templates/` (yours), `runs/<run>/` (run.json, `out/`, `logs/`, `lab/`) and
`s/` (the runner's socket while it runs).

### Report format

```markdown
# Test Lab report

## Summary

<text>

## Checks

- [PASS] <name> — <detail>
- [FAIL] <name> — <detail>
- [SKIP] <name>
```

The parser (`services/test-lab/report.ts`) also accepts `*`, `[ok]`,
`[passed]`, `[failed]`, `[skipped]` and `--`, `-` or `:` before the detail.
A run **passed** with no FAIL, **failed** with one, is **stopped** when a cap,
limit, Stop or restart ended it, and shows **No report** without checks.

## Safety

- **Labels.** Everything a run makes carries `studio.testlab.run=<run>`,
  `studio.testlab.instance=<hash of HERMES_WEB_UI_HOME>` and
  `studio.testlab.created=<ms>`. Removal lists by both labels and checks each
  item's labels again before deleting it, so a Docker that ignores the filter
  still cannot make Studio remove anything else. Two Studios on one Docker never
  remove each other's runs.
- **Startup sweep.** 10 s after Studio starts, runs it was following end as
  "Stopped: Studio restarted"; their containers go unless they were kept, and
  every run of this Studio older than a day is removed, kept or not.
- **Model pin.** While a run is active, the model gateway answers its
  credential only for the picked model (`services/test-lab/pin.ts`, checked in
  `middleware/model-gateway.ts` before run limits): another model in the
  request, or a credential bound to another model, gets HTTP 400 "This Test Lab
  run is pinned to …". After the run nothing passes. The runner never sees the
  credential: Studio's socket adds it and allows only
  `POST /v1/chat/completions` (403 for anything else).
- **Spending cap.** The run's cap and time limit are set as its run limits
  ([agent-limits.md](agent-limits.md)) under `testlab-<run>`: the gateway
  counts each response's price (manual price on the Usage page, then the
  models.dev catalog) and refuses the next request once the cap is passed, which
  ends the agent ("Stopped: spending cap reached"). For an OpenRouter provider
  Studio also reads the key's usage counter (`GET /api/v1/key`) before, every
  15 s during and after the run, and kills the runner when it went up by the
  cap. The cost shown is both numbers.
- **The Docker socket** itself gives Studio (and anyone who can act as a super
  admin) full control of Docker. Test Lab only uses it as above.

## Templates

JSON files, one app each: Studio's in `packages/server/src/assets/test-lab/templates/`,
yours in `HERMES_WEB_UI_HOME/test-lab/templates/` (the same `id` replaces
Studio's). Broken files are listed on the page and not offered.

| Field | |
| --- | --- |
| `id` | Lowercase, also the app's name on the lab network |
| `name`, `description` | Shown on the page |
| `image` | A fixed version (`repo:1.2.3` or `@sha256:`); `latest`, `stable`, `nightly`… are refused |
| `build.git` | `https://…[.git][#branch]` to build when there is no image; `""` asks the user |
| `port`, `env`, `entrypoint`, `cmd`, `memory`, `start` | How it runs; `start` is the first page |
| `health` | `path`, `timeoutSeconds` (default 180), `expect` (status codes; default 2xx/3xx) |
| `logins` | Told to the agent and shown on the page |
| `seed` | Steps `{ name, method, path, json or form, headers, expect, save, optional }`; `{{var}}` fills values saved earlier (`"save": { "token": "access_token" }`, `"header:token"` for a response header) |
| `notes` | Told to the agent |
| `sizeMb` | Rough download size, shown on the page |

Included:

| App | Image | Test data |
| --- | --- | --- |
| Vikunja | `vikunja/vikunja:2.7.1` (SQLite) | alice and bob; alice's private project with "Alice's secret task" |
| Mealie | `hkotel/mealie:v3.29.0` | default admin; alice; a recipe (optional steps) |
| Mattermost (preview) | `mattermost/mattermost-preview:11.11.4` (about 1.1 GB) | labadmin (first user, admin), alice, team Lab |
| Home Assistant (demo) | `homeassistant/home-assistant:2026.11.1` with `demo:` | onboarding done, owner testadmin |
| Pondering Orb | built from `Wizard815/pondering-orb#main` | password `lab-pass-123` |
| Another Studio | built from `Wizard815/hermes-studio#studio-herder` (large, slow) | admin / 123456 |
| ALLGlance | built from the git URL you give | none; port 8080 and health `/` are a guess |
| Static page (nginx) | `nginx:1.29.8-alpine` | none: a quick check of the lab itself |

## What goes wrong

- **Pull fails** (rate limit, ghcr.io blocked): the app shows "Pull failed"
  with Docker's message and is left out. Set another mirror, or build it.
- **Studio runs in Docker:** bind mounts need host paths. Studio reads its own
  mounts (`docker inspect` of itself) and maps `HERMES_WEB_UI_HOME`; it must be
  on a mounted volume or the run stops with "Test Lab needs … on a mounted
  volume".
- **Socket path too long:** the runner's socket is
  `HERMES_WEB_UI_HOME/test-lab/s/<10 hex>/lab.sock`; a long home folder makes
  it longer than a Unix socket allows and the run stops saying so.
- **Health check times out:** the app shows "not healthy" with the last answer
  and the agent still runs against the apps that answered; with none, the report
  says no app became healthy.
- **Seed step fails:** the app's message names the step; optional steps do not
  stop the rest. The agent is told the test data may be missing.
- **No browser** (pull failed or Chrome did not answer): the agent gets
  "No browser in this run: use http_request".
- **Unpriced model:** the gateway cost stays $0 and only OpenRouter's counter
  (OpenRouter providers) can stop the run at the cap. Set a manual price on the
  Usage page for other providers.
- Seed steps for Mealie, Mattermost and Home Assistant were written from their
  API documentation and not run here (large images); Orb, Studio and ALLGlance
  builds were not run either.

## Code

- Server: `modules/studio/services/test-lab/` (`service.ts` runs, `docker.ts`
  labelled Engine API calls, `templates.ts`, `report.ts`, `pin.ts`,
  `openrouter.ts`, `index.ts` wiring), `controllers/test-lab.ts`,
  `routes/test-lab.ts`, `public/test-lab.ts` (startup sweep), the runner
  `assets/test-lab/runner.mjs`.
- API (super admin): `GET /api/studio/test-lab`, `PUT …/settings`,
  `GET|POST …/runs`, `GET …/runs/:id`, `POST …/runs/:id/stop`,
  `DELETE …/runs/:id/containers`, `GET …/runs/:id/screenshots/:name`,
  `…/logs/:app`, `…/download`.
- Client: `views/hermes/TestLabView.vue`, `api/studio/test-lab.ts`, strings in
  `i18n/test-lab-messages.ts`.
- Tests: `tests/server/test-lab-*.test.ts` (fake Docker API in
  `tests/server/fixtures/fake-docker.ts`), `tests/e2e/test-lab-view.spec.ts`.
