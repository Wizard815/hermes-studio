# Browser tasks (browser-use)

Type a task above the browser panel's view, pick a model, and press **Run**.
[browser-use](https://github.com/browser-use/browser-use) 1.0.4 does it in the
panel's own browser: you watch each step, the view follows the tabs it opens,
and the result shows under the task. Super administrators only.

```
Open https://example.com, click "Learn more", and tell me the page title.
```

## Models

The model list is Studio's own providers, limited to models with an
OpenAI-compatible chat API:

- **Argos** (llama.cpp on the homelab GPUs): add Argos as a provider
  (`http://argos:8080/v1`, or the NUC's address) and pick one of its models.
  Tested with Gemma 4 31B behind Argos. Small models (under about 30B) often
  stop early or answer with code instead of doing the task.
- **OpenRouter**: any chat model. Tested with Claude Haiku 5.5 (about $0.002
  a task).
- Anything else that speaks `/v1/chat/completions` (vLLM, Ollama).

The panel remembers the last model you picked. `BROWSER_TASK_MODEL` (a model id
from the list, like `openrouter/anthropic/claude-haiku-5.5`) sets the default.
Models without vision work too; the cost shows only when browser-use knows the
model's price.

## Pin comments

Pin comments work the same during and after a task: **Comment** pins a spot on
the page the task is on, and the comment (with the element under the pin) goes
to the open chat. The page a task ends on stays open in the panel, so you can
pin a comment on what it found.

## How it works

- The panel's browser now runs with a DevTools port on `127.0.0.1` (a random
  port, in a fresh profile per start). When Studio is attached to the agents'
  Screen browser instead, tasks use that browser's port.
- `services/browser-task/service.ts` runs `bin/browser-use-task.py` with the
  Python that has browser-use: `BROWSER_USE_PYTHON`, then
  `/opt/browser-use/bin/python` (the Docker image's venv), then `python3`.
  The request goes on stdin and the model's key in `BROWSER_TASK_API_KEY`,
  never on the command line. Steps come back as JSON lines.
- browser-use works in a tab of its own; while a task runs, new tabs become the
  panel's active tab. **Stop** ends the task and leaves its page open.
- browser-use's telemetry and update check are off.
- API (super admin): `GET /api/studio/browser/task` (whether tasks can run, and
  the last task), `GET …/task/models`, `POST …/task` (`{task, model}`),
  `POST …/task/stop`. The `browser.task` socket event says only that a task
  changed (id, status, step count); the panel reads the rest from the API.

## What goes wrong

- **"Browser tasks need browser-use on the server":** the image was built
  without it, or `BROWSER_USE_PYTHON` points at a Python without
  `browser-use==1.0.4`. Install it in a venv and set `BROWSER_USE_PYTHON`.
- **No models in the list:** no provider with an OpenAI-compatible chat API is
  set up. Anthropic-only or Bedrock providers can't run browser tasks.
- **"Finished, not done":** the model gave up. Try a bigger model or a more
  specific task.
- **It stops at a login, 2FA or CAPTCHA:** sign in yourself in the panel (or on
  the Screen), then run the task again.
- **Not a sandbox.** browser-use runs the Python the model writes, as Studio's
  user, against a browser that may be signed in to your sites. Only super
  administrators can run tasks, and the task is told never to buy, post, send
  or delete unless you say so, but a bad model can still try. The DevTools port
  listens on loopback with no password: anything else in the container can
  drive the panel's browser.

## Tests

- `tests/server/browser-task.test.ts`: the runner with a fake browser-use, and
  the shared browser (a tab opened over DevTools becomes a panel tab, and pin
  comments read it).
- `tests/live/browser-task.live.test.ts`: real browser-use and a real model.
  See the file for the environment variables (OpenRouter or Argos).
- `tests/e2e/browser-task.live.spec.ts`: the same in the panel, in a browser.
  `BROWSER_TASK_VIDEO=1` records a video of the run.
