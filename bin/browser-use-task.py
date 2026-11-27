#!/usr/bin/env python3
"""Run one browser-use task on the browser Studio's panel shows (docs/browser-tasks.md).

Studio starts this with the Python that has browser-use installed (BROWSER_USE_PYTHON,
/opt/browser-use/bin/python in the Docker image). The request comes on stdin as JSON:

    {"task": "...", "cdp_url": "http://127.0.0.1:PORT", "model": "...", "base_url": "...",
     "max_steps": 25, "timeout": 600, "vision": true}

The model's key comes in the BROWSER_TASK_API_KEY environment variable, never argv.
Progress goes to stdout as one JSON object per line:

    {"type": "started", "version": "1.0.4"}
    {"type": "step", "n": 1, "text": "new_tab(\"https://example.com\")"}
    {"type": "done", "status": "completed", "success": true, "text": "...", "steps": 3,
     "cost_usd": 0.002, "error": null}

`python3 browser-use-task.py --check` prints {"ok": true, "version": ...} when browser-use loads.
"""

import asyncio
import json
import logging
import os
import re
import signal
import sys

# Before browser_use is imported: no telemetry, no update check, no ad banner, our own logging.
os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BH_TELEMETRY"] = "0"
os.environ["BROWSER_USE_NO_UPDATE_CHECK"] = "1"
os.environ["BROWSER_USE_SETUP_LOGGING"] = "false"

_STEP = re.compile(r"^step (\d+): (.*)$", re.S)
_HOUSE_RULES = (
    "You are driving the browser in Hermes Studio's browser panel. A person may be watching it live "
    "and may be signed in to sites in it. Work in the tab that is open unless the task needs another one. "
    "Never buy anything, send messages, post, delete, or change account settings unless the task says so "
    "in plain words. If a login, 2FA or CAPTCHA blocks you, stop and say so in your result."
)


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


class _StepHandler(logging.Handler):
    """browser-use logs each step as one INFO line on browser_use.agent.loop: 'step N: <code>'."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            match = _STEP.match(record.getMessage())
        except Exception:  # a bad log record must not end the run
            return
        if match:
            emit({"type": "step", "n": int(match.group(1)), "text": match.group(2)[:600]})


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("browser-use")
    except Exception:
        return "unknown"


def _bounded(value, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


async def run(request: dict) -> int:
    from browser_use import Agent, Browser, ChatOpenAI

    task = str(request.get("task") or "").strip()
    cdp_url = str(request.get("cdp_url") or "").strip()
    model = str(request.get("model") or "").strip()
    base_url = str(request.get("base_url") or "").strip()
    if not task or not cdp_url or not model or not base_url:
        emit({"type": "done", "status": "error", "error": "task, cdp_url, model and base_url are required"})
        return 2

    loop_logger = logging.getLogger("browser_use.agent.loop")
    loop_logger.setLevel(logging.INFO)
    loop_logger.addHandler(_StepHandler())
    logging.getLogger("browser_use").setLevel(logging.INFO)

    # Any OpenAI-compatible server: Argos (llama.cpp), OpenRouter, a local vLLM. A local
    # server without a key still needs a non-empty one for the client.
    llm = ChatOpenAI(model, base_url=base_url, api_key=os.environ.get("BROWSER_TASK_API_KEY") or "none")
    # keep_alive: the panel's browser outlives the task; it is Studio's, not ours.
    browser = Browser(cdp_url=cdp_url, keep_alive=True)
    agent_kwargs = {"llm": llm, "browser": browser, "extend_system_message": _HOUSE_RULES}
    if request.get("vision") is False:
        agent_kwargs["use_vision"] = False  # text-only local models: no screenshots reach the model
    agent = Agent(task, **agent_kwargs)
    emit({"type": "started", "version": _version()})

    runner = asyncio.ensure_future(
        agent.run(
            max_steps=_bounded(request.get("max_steps"), 25, 1, 100),
            timeout=_bounded(request.get("timeout"), 600, 30, 3600),
        )
    )
    # Stop from Studio: SIGTERM cancels the run; the browser stays (keep_alive).
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, runner.cancel)
    try:
        result = await runner
    except asyncio.CancelledError:
        emit({"type": "done", "status": "stopped", "error": "Stopped"})
        return _leave_page(browser, 130)
    except Exception as error:  # noqa: BLE001 - reported to the panel, not raised
        emit({"type": "done", "status": "error", "error": f"{type(error).__name__}: {error}"[:2000]})
        return _leave_page(browser, 1)
    emit(
        {
            "type": "done",
            "status": result.status,
            "success": result.success,
            "text": (result.text or "")[:20000],
            "steps": result.steps,
            "cost_usd": result.cost_usd,
            "error": result.error,
        }
    )
    return _leave_page(browser, 0)


def _leave_page(browser, code: int) -> int:
    """End without browser-use's exit cleanup: its browser-harness daemon closes the tab it worked in when it
    shuts down, and the person should see the page the task left in the panel (and pin comments on it).
    So: stop the REPL workers, kill the daemon without a shutdown request, and exit at once."""
    try:
        from browser_use.browser.browser import _kill_daemon
        from browser_use.repl.session import kill_workers

        kill_workers()
        if getattr(browser, "name", None):
            _kill_daemon(browser.name)
    except Exception as error:  # noqa: BLE001 - the result is already out
        sys.stderr.write(f"cleanup: {error}\n")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


def main() -> int:
    if "--check" in sys.argv[1:]:
        try:
            import browser_use  # noqa: F401
        except Exception as error:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(error).__name__}: {error}"})
            return 1
        emit({"ok": True, "version": _version()})
        return 0
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as error:
        emit({"type": "done", "status": "error", "error": f"Bad request: {error}"})
        return 2
    return asyncio.run(run(request))


if __name__ == "__main__":
    sys.exit(main())
