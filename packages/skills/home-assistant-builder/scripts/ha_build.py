#!/usr/bin/env python3
"""Build scripts and automations for Home Assistant; Home Assistant runs them.

Hermes writes a package YAML (only `script:` and `automation:`), this tool copies
it to <config>/packages/hermes/<name>.yaml over SSH, has Home Assistant check its
configuration, and reloads scripts and automations. It can also start a script.
Those are the only Home Assistant calls it makes: check_config, script.reload,
automation.reload, script.turn_on. There is no general device control here.

Settings come from the environment or the Hermes profile's .env:
  HA_BUILD_URL         Home Assistant address, e.g. http://homeassistant.local:8123
  HA_BUILD_TOKEN       long-lived access token (for check/reload/run)
  HA_BUILD_SSH_HOST    SSH host: Home Assistant OS's "Terminal & SSH" or "Advanced SSH & Web
                       Terminal" add-on, or the Docker host of a Home Assistant container
  HA_BUILD_SSH_PORT    default 22
  HA_BUILD_SSH_USER    default root
  HA_BUILD_SSH_KEY     private key file on this machine (optional)
  HA_BUILD_CONFIG_DIR  Home Assistant's config folder on that host; empty or "auto" = find it
                       (/homeassistant, then /config: the add-ons differ by version)
  HA_BUILD_DOCKER      instead of SSH: a Home Assistant container on this machine (docker exec)

Home Assistant OS: in the SSH add-ons the `ha` CLI is there and the add-on hands its
SUPERVISOR_TOKEN to SSH commands (~/.ssh/environment, /etc/profile.d/homeassistant.sh), so
the config check is `ha core check`. Elsewhere it is Home Assistant's check_config API.
Scripts and automations load from a package folder: configuration.yaml needs
`homeassistant: packages: !include_dir_named packages`. This tool never edits
configuration.yaml; `status` prints the line to add when it is missing.

Deploy and run need --confirm with the code `show` printed (deploy) or the
script's entity id (run): ask the user first and show them the YAML.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request

KEYS = ("HA_BUILD_URL", "HA_BUILD_TOKEN", "HA_BUILD_SSH_HOST", "HA_BUILD_SSH_PORT", "HA_BUILD_SSH_USER",
        "HA_BUILD_SSH_KEY", "HA_BUILD_CONFIG_DIR", "HA_BUILD_DOCKER")
NAME_RE = re.compile(r"^[a-z0-9_]{1,64}$")
PACKAGES_LINE = "  packages: !include_dir_named packages"
CONFIG_DIRS = ("/homeassistant", "/config")
# The add-ons give SSH commands SUPERVISOR_TOKEN through ~/.ssh/environment (PermitUserEnvironment);
# a login profile or s6's saved environment are the fallbacks when sshd does not pass it on.
SUPERVISOR_ENV = (
    'if [ -z "${SUPERVISOR_TOKEN:-}" ]; then for f in /etc/profile.d/homeassistant.sh ~/.ssh/environment '
    '/data/.ssh/environment; do [ -r "$f" ] || continue; t=$(sed -n \'s/^\\(export \\)\\{0,1\\}SUPERVISOR_TOKEN=//p\' "$f" '
    '| tail -n 1 | tr -d \'"\\047\'); [ -n "$t" ] && { SUPERVISOR_TOKEN=$t; break; }; done; fi; '
    'if [ -z "${SUPERVISOR_TOKEN:-}" ] && [ -r /run/s6/container_environment/SUPERVISOR_TOKEN ]; then '
    'SUPERVISOR_TOKEN=$(cat /run/s6/container_environment/SUPERVISOR_TOKEN); fi; export SUPERVISOR_TOKEN; '
)


def fail(message, code=1):
    print(f"ERROR: {message}")
    sys.exit(code)


def load_settings():
    values = {}
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    env_file = os.path.join(home, ".env")
    try:
        with open(env_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip().removeprefix("export ").strip()
                if key in KEYS:
                    values[key] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    for key in KEYS:
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


class Remote:
    """Runs a shell command in Home Assistant's config host: over SSH, or docker exec."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.ssh = False
        if cfg.get("HA_BUILD_DOCKER"):
            self.base = ["docker", "exec", "-i", cfg["HA_BUILD_DOCKER"]]
        elif cfg.get("HA_BUILD_SSH_HOST"):
            base = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
                    "-p", str(cfg.get("HA_BUILD_SSH_PORT") or 22)]
            if cfg.get("HA_BUILD_SSH_KEY"):
                base += ["-i", os.path.expanduser(cfg["HA_BUILD_SSH_KEY"])]
            base.append(f"{cfg.get('HA_BUILD_SSH_USER') or 'root'}@{cfg['HA_BUILD_SSH_HOST']}")
            self.base = base
            self.ssh = True
        else:
            fail("No way into Home Assistant's config folder: set HA_BUILD_SSH_HOST (or HA_BUILD_DOCKER).")
        configured = (cfg.get("HA_BUILD_CONFIG_DIR") or "").strip()
        self.config_dir = configured if configured not in ("", "auto") else self.find_config_dir()

    def run(self, script, stdin=None):
        if self.ssh:
            script = SUPERVISOR_ENV + script
            cmd = self.base + ["sh", "-c", shlex.quote(script)]
        else:
            cmd = self.base + ["sh", "-c", script]
        try:
            res = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            return 124, "", "timed out"
        return res.returncode, res.stdout, res.stderr.strip()

    def find_config_dir(self):
        """The add-ons mount Home Assistant's config at /homeassistant (and link /config to it on
        newer versions); older ones and containers use /config."""
        probe = "; ".join(f"[ -f {d}/configuration.yaml ] && {{ echo {d}; exit 0; }}" for d in CONFIG_DIRS) + "; exit 3"
        code, out, err = self.run(probe)
        if code == 0 and out.strip():
            return out.strip().splitlines()[-1]
        if code == 3:
            fail("No configuration.yaml in /homeassistant or /config on that host. Is this Home Assistant's SSH add-on?"
                 " Otherwise set the config folder (HA_BUILD_CONFIG_DIR).")
        fail(f"Cannot reach Home Assistant's config folder over SSH: {err or out or 'exit ' + str(code)}")

    def ha_cli(self):
        """True when the `ha` CLI and the add-on's SUPERVISOR_TOKEN are there (Home Assistant OS)."""
        if not hasattr(self, "_ha_cli"):
            code, out, _ = self.run('command -v ha >/dev/null 2>&1 && [ -n "${SUPERVISOR_TOKEN:-}" ] && echo yes || echo no')
            self._ha_cli = code == 0 and out.strip().endswith("yes")
        return self._ha_cli

    def path(self, *parts):
        return "/".join([self.config_dir.rstrip("/")] + list(parts))


def ha_call(cfg, method, path, body=None, missing_ok=False):
    url = (cfg.get("HA_BUILD_URL") or "").rstrip("/")
    token = cfg.get("HA_BUILD_TOKEN")
    if not url or not token:
        fail("Set HA_BUILD_URL and HA_BUILD_TOKEN (a long-lived access token).")
    allowed = {("POST", "/api/config/core/check_config"), ("POST", "/api/services/script/reload"),
               ("POST", "/api/services/automation/reload"), ("POST", "/api/services/script/turn_on"),
               ("GET", "/api/")}
    readable = re.match(r"^/api/states/(script|automation)\.[a-z0-9_]+$", path) and method == "GET"
    if (method, path) not in allowed and not readable:
        fail(f"{method} {path} is not allowed")
    data = json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None)
    req = urllib.request.Request(url + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        if missing_ok and exc.code == 404:
            return None
        fail(f"Home Assistant answered {exc.code} for {path}: {exc.read()[:300].decode(errors='replace')}")
    except OSError as exc:
        fail(f"Cannot reach Home Assistant at {url}: {exc}")


def check_config(cfg, remote=None):
    """Home Assistant OS: `ha core check` in the SSH add-on. Otherwise the check_config API."""
    if remote is not None and remote.ssh and remote.ha_cli():
        code, out, err = remote.run("ha core check --raw-json")
        try:
            result = json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            result = None
        if isinstance(result, dict):
            return result.get("result") == "ok", result.get("message") or ""
        return code == 0, (err or out).strip()
    result = ha_call(cfg, "POST", "/api/config/core/check_config")
    return result.get("result") == "valid", result.get("errors") or ""


def packages_state(remote):
    """Where configuration.yaml loads packages from. Returns (folder for Hermes's files, None) when
    `homeassistant: packages: !include_dir_named <dir>` is there, else (None, what to tell the user)."""
    code, text, err = remote.run(f"cat {shlex.quote(remote.path('configuration.yaml'))}")
    if code != 0:
        fail(f"Cannot read configuration.yaml: {err}")
    lines = text.splitlines()
    in_core = False
    has_core = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            in_core = bool(re.match(r"^homeassistant:\s*(#.*)?$", line))
            has_core = has_core or in_core or line.startswith("homeassistant:")
            continue
        m = re.match(r"^\s+packages:\s*(.*?)\s*(#.*)?$", line) if in_core else None
        if not m:
            continue
        value = m.group(1)
        named = re.match(r"^!include_dir_named\s+['\"]?([^'\"]+?)['\"]?$", value)
        if named:
            folder = named.group(1).strip().rstrip("/")
            if folder.startswith("/"):
                return None, (f"configuration.yaml loads packages from {folder}, an absolute path. Use "
                              f"`packages: !include_dir_named packages` (a folder next to configuration.yaml).")
            # include_dir_named reads sub-folders too, so Hermes's files go in <folder>/hermes.
            return (folder if folder.endswith("hermes") else folder + "/hermes"), None
        return None, (f"configuration.yaml has `packages: {value}` under homeassistant:, which Hermes cannot add to. "
                      f"Change it to `packages: !include_dir_named packages` (move existing packages into that "
                      f"folder), then restart Home Assistant.")
    where = ("under the homeassistant: section that is already there" if has_core
             else "at the end (both lines)")
    line = PACKAGES_LINE.strip() if has_core else "homeassistant:\n" + PACKAGES_LINE
    return None, (f"Packages are not turned on. Add this to {remote.path('configuration.yaml')} {where}, then "
                  f"restart Home Assistant once (Settings > System > Restart):\n{line}")


def validate_package(text):
    """Only `script:` and `automation:` at the top; no includes that pull in other files."""
    problems = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace() and not line.startswith("-"):
            key = line.split(":", 1)[0].strip()
            if key not in ("script", "automation"):
                problems.append(f"line {number}: top-level '{key}' is not allowed (only script: and automation:)")
        if re.search(r"!include", line):
            problems.append(f"line {number}: !include is not allowed")
    if not re.search(r"^(script|automation):", text, re.M):
        problems.append("the package has no script: or automation: section")
    return problems


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def read_file(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        fail(f"Cannot read {path}: {exc}")


def cmd_status(cfg, _args):
    shown = {k: ("(set)" if k == "HA_BUILD_TOKEN" else v) for k, v in cfg.items()}
    print("Settings:", json.dumps(shown))
    print("Home Assistant API:", ha_call(cfg, "GET", "/api/").get("message", "?"))
    remote = Remote(cfg)
    print("Config folder:", remote.config_dir)
    if remote.ssh:
        print("Config check:", "`ha core check` (Home Assistant OS add-on, SUPERVISOR_TOKEN found)" if remote.ha_cli()
              else "Home Assistant's check_config API (no `ha` CLI with a SUPERVISOR_TOKEN on that host)")
    folder, problem = packages_state(remote)
    if problem:
        print("Packages: NOT READY\n" + problem)
        print("Tell the user exactly that; do not edit configuration.yaml yourself.")
        return
    code, out, _ = remote.run(f"ls {shlex.quote(remote.path(folder))} 2>/dev/null || true")
    print(f"Packages: ready; Hermes's files go in {remote.path(folder)}")
    print("Deployed:", " ".join(out.split()) or "(none yet)")


def cmd_setup(cfg, _args):
    """Only checks: Hermes never edits configuration.yaml. Prints the line to add when packages are off."""
    remote = Remote(cfg)
    folder, problem = packages_state(remote)
    if problem:
        print(problem)
        print("Tell the user exactly that; do not edit configuration.yaml yourself.")
        sys.exit(2)
    print(f"Packages are on; Hermes's files go in {remote.path(folder)}.")


def cmd_show(_cfg, args):
    text = read_file(args.file)
    problems = validate_package(text)
    if problems:
        fail("The package is not allowed:\n" + "\n".join(problems))
    print(text.rstrip())
    print(f"\nCONFIRM={digest(text)}")


def need_packages(remote):
    folder, problem = packages_state(remote)
    if problem:
        fail(problem + "\nTell the user exactly that; do not edit configuration.yaml yourself.", 2)
    return folder


def ids_in(text, section):
    """Top-level ids under `script:` (keys) or `automation:` (- id: ...)."""
    found, current = [], None
    for line in text.splitlines():
        if line and not line[0].isspace() and not line.startswith("-"):
            current = line.split(":", 1)[0].strip()
            continue
        if current == "script" == section:
            m = re.match(r"^  ([a-z0-9_]+):\s*$", line)
            if m:
                found.append(m.group(1))
        if current == "automation" == section:
            m = re.match(r"^\s*-?\s*id:\s*['\"]?([A-Za-z0-9_]+)", line)
            if m:
                found.append(m.group(1))
    return found


def cmd_deploy(cfg, args):
    if not NAME_RE.match(args.name):
        fail("--name must be lowercase letters, digits and _")
    text = read_file(args.file)
    problems = validate_package(text)
    if problems:
        fail("The package is not allowed:\n" + "\n".join(problems))
    if args.confirm != digest(text):
        fail("--confirm does not match this YAML. Run show, ask the user with the YAML, then deploy with that code.")
    remote = Remote(cfg)
    folder = remote.path(need_packages(remote))
    target = f"{folder}/{args.name}.yaml"
    q = shlex.quote
    code, _, err = remote.run(f"mkdir -p {q(folder)} && (test ! -f {q(target)} || cp {q(target)} {q(target)}.bak) && cat > {q(target)}.new"
                              f" && mv {q(target)}.new {q(target)}", stdin=text if text.endswith("\n") else text + "\n")
    if code != 0:
        fail(f"Could not copy the package: {err}")
    ok, errors = check_config(cfg, remote)
    if not ok:
        remote.run(f"if [ -f {q(target)}.bak ]; then mv {q(target)}.bak {q(target)}; else rm -f {q(target)}; fi")
        fail(f"Home Assistant's config check failed, so the change was undone:\n{errors}")
    remote.run(f"rm -f {q(target)}.bak")
    if re.search(r"^script:", text, re.M):
        ha_call(cfg, "POST", "/api/services/script/reload")
    if re.search(r"^automation:", text, re.M):
        ha_call(cfg, "POST", "/api/services/automation/reload")
    print(f"Deployed {target}; config check passed; reloaded.")
    # A package Home Assistant has not loaded (packages line added but no restart yet) checks fine
    # and reloads fine, but nothing appears. Say so instead of claiming success.
    missing = [f"script.{i}" for i in ids_in(text, "script")
               if ha_call(cfg, "GET", f"/api/states/script.{i}", missing_ok=True) is None]
    if missing:
        print("WARNING: Home Assistant did not load " + ", ".join(missing) + ". If the packages line was just added,"
              " restart Home Assistant once; otherwise check Home Assistant's log for this script.")


def cmd_remove(cfg, args):
    if not NAME_RE.match(args.name) or args.confirm != args.name:
        fail("Ask the user first, then run: remove NAME --confirm NAME")
    remote = Remote(cfg)
    target = remote.path(need_packages(remote), f"{args.name}.yaml")
    remote.run(f"rm -f {shlex.quote(target)}")
    ok, errors = check_config(cfg, remote)
    if not ok:
        fail(f"Removed, but Home Assistant's config check now fails: {errors}")
    ha_call(cfg, "POST", "/api/services/script/reload")
    ha_call(cfg, "POST", "/api/services/automation/reload")
    print(f"Removed {target}; reloaded.")


def cmd_run(cfg, args):
    entity = args.script
    if not re.match(r"^script\.[a-z0-9_]+$", entity):
        fail("Only scripts can be started: script.<name>")
    if args.confirm != entity:
        fail(f"Ask the user first, then run: run {entity} --confirm {entity}")
    ha_call(cfg, "POST", "/api/services/script/turn_on", {"entity_id": entity})
    print(f"Started {entity}. Home Assistant runs it.")


def cmd_check(cfg, _args):
    remote = Remote(cfg) if (cfg.get("HA_BUILD_SSH_HOST") or cfg.get("HA_BUILD_DOCKER")) else None
    ok, errors = check_config(cfg, remote)
    print("Config check: valid" if ok else f"Config check: invalid\n{errors}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    sub.add_parser("setup")
    p = sub.add_parser("show")
    p.add_argument("file")
    p = sub.add_parser("deploy")
    p.add_argument("file")
    p.add_argument("--name", required=True)
    p.add_argument("--confirm", default="")
    p = sub.add_parser("remove")
    p.add_argument("name")
    p.add_argument("--confirm", default="")
    p = sub.add_parser("run")
    p.add_argument("script")
    p.add_argument("--confirm", default="")
    args = parser.parse_args()
    cfg = load_settings()
    {"status": cmd_status, "check": cmd_check, "setup": cmd_setup, "show": cmd_show, "deploy": cmd_deploy,
     "remove": cmd_remove, "run": cmd_run}[args.command](cfg, args)


if __name__ == "__main__":
    main()
