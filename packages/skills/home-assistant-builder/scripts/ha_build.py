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
  HA_BUILD_SSH_HOST    SSH host (Home Assistant's SSH add-on, or the Docker host)
  HA_BUILD_SSH_PORT    default 22
  HA_BUILD_SSH_USER    default root
  HA_BUILD_SSH_KEY     private key file on this machine (optional)
  HA_BUILD_CONFIG_DIR  Home Assistant's config folder on that host, default /config
  HA_BUILD_DOCKER      instead of SSH: a Home Assistant container on this machine (docker exec)

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
PACKAGES_LINE = "  packages: !include_dir_named packages/hermes"


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
        self.config_dir = cfg.get("HA_BUILD_CONFIG_DIR") or "/config"
        if cfg.get("HA_BUILD_DOCKER"):
            self.base = ["docker", "exec", "-i", cfg["HA_BUILD_DOCKER"]]
        elif cfg.get("HA_BUILD_SSH_HOST"):
            base = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
                    "-p", str(cfg.get("HA_BUILD_SSH_PORT") or 22)]
            if cfg.get("HA_BUILD_SSH_KEY"):
                base += ["-i", os.path.expanduser(cfg["HA_BUILD_SSH_KEY"])]
            base.append(f"{cfg.get('HA_BUILD_SSH_USER') or 'root'}@{cfg['HA_BUILD_SSH_HOST']}")
            self.base = base
        else:
            fail("No way into Home Assistant's config folder: set HA_BUILD_SSH_HOST (or HA_BUILD_DOCKER).")

    def run(self, script, stdin=None):
        cmd = self.base + ["sh", "-c", shlex.quote(script)] if self.base[0] == "ssh" else self.base + ["sh", "-c", script]
        res = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=60)
        return res.returncode, res.stdout, res.stderr.strip()

    def path(self, *parts):
        return "/".join([self.config_dir.rstrip("/")] + list(parts))


def ha_call(cfg, method, path, body=None):
    url = (cfg.get("HA_BUILD_URL") or "").rstrip("/")
    token = cfg.get("HA_BUILD_TOKEN")
    if not url or not token:
        fail("Set HA_BUILD_URL and HA_BUILD_TOKEN (a long-lived access token).")
    allowed = {("POST", "/api/config/core/check_config"), ("POST", "/api/services/script/reload"),
               ("POST", "/api/services/automation/reload"), ("POST", "/api/services/script/turn_on"),
               ("GET", "/api/")}
    if (method, path) not in allowed:
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
        fail(f"Home Assistant answered {exc.code} for {path}: {exc.read()[:300].decode(errors='replace')}")
    except OSError as exc:
        fail(f"Cannot reach Home Assistant at {url}: {exc}")


def check_config(cfg):
    result = ha_call(cfg, "POST", "/api/config/core/check_config")
    return result.get("result") == "valid", result.get("errors") or ""


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
    code, out, err = remote.run(f"grep -n 'packages' {shlex.quote(remote.path('configuration.yaml'))} || true; "
                                f"ls {shlex.quote(remote.path('packages', 'hermes'))} 2>/dev/null || true")
    if code != 0:
        fail(f"Cannot reach the config folder: {err}")
    print("configuration.yaml packages lines and deployed packages:\n" + (out.strip() or "(none: run setup)"))


def cmd_setup(cfg, args):
    remote = Remote(cfg)
    conf = remote.path("configuration.yaml")
    code, text, err = remote.run(f"cat {shlex.quote(conf)}")
    if code != 0:
        fail(f"Cannot read configuration.yaml: {err}")
    if "packages/hermes" in text:
        print("Already set up: configuration.yaml loads packages/hermes.")
        return
    if re.search(r"^\s+packages:", text, re.M):
        fail("configuration.yaml already has a packages: line. Add packages/hermes to it by hand, then restart Home Assistant.")
    if re.search(r"^homeassistant:", text, re.M):
        fail("configuration.yaml already has a homeassistant: section. Add this under it by hand, then restart Home Assistant:\n"
             + PACKAGES_LINE)
    if args.confirm != "setup":
        print("This adds to configuration.yaml:\nhomeassistant:\n" + PACKAGES_LINE)
        print("Ask the user, then run: setup --confirm setup")
        return
    addition = "\nhomeassistant:\n" + PACKAGES_LINE + "\n"
    code, _, err = remote.run(f"cp {shlex.quote(conf)} {shlex.quote(conf)}.hermes-bak && mkdir -p {shlex.quote(remote.path('packages', 'hermes'))}"
                              f" && cat >> {shlex.quote(conf)}", stdin=addition)
    if code != 0:
        fail(f"Could not update configuration.yaml: {err}")
    ok, errors = check_config(cfg)
    if not ok:
        remote.run(f"mv {shlex.quote(conf)}.hermes-bak {shlex.quote(conf)}")
        fail(f"Home Assistant rejected the change, so it was undone: {errors}")
    print("Done. Restart Home Assistant once (Settings > System > Restart) so it loads packages/hermes.")


def cmd_show(_cfg, args):
    text = read_file(args.file)
    problems = validate_package(text)
    if problems:
        fail("The package is not allowed:\n" + "\n".join(problems))
    print(text.rstrip())
    print(f"\nCONFIRM={digest(text)}")


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
    folder = remote.path("packages", "hermes")
    target = remote.path("packages", "hermes", f"{args.name}.yaml")
    q = shlex.quote
    code, _, err = remote.run(f"mkdir -p {q(folder)} && (test ! -f {q(target)} || cp {q(target)} {q(target)}.bak) && cat > {q(target)}.new"
                              f" && mv {q(target)}.new {q(target)}", stdin=text if text.endswith("\n") else text + "\n")
    if code != 0:
        fail(f"Could not copy the package: {err}")
    ok, errors = check_config(cfg)
    if not ok:
        remote.run(f"if [ -f {q(target)}.bak ]; then mv {q(target)}.bak {q(target)}; else rm -f {q(target)}; fi")
        fail(f"Home Assistant's config check failed, so the change was undone:\n{errors}")
    remote.run(f"rm -f {q(target)}.bak")
    if re.search(r"^script:", text, re.M):
        ha_call(cfg, "POST", "/api/services/script/reload")
    if re.search(r"^automation:", text, re.M):
        ha_call(cfg, "POST", "/api/services/automation/reload")
    print(f"Deployed {target}; config check passed; reloaded.")


def cmd_remove(cfg, args):
    if not NAME_RE.match(args.name) or args.confirm != args.name:
        fail("Ask the user first, then run: remove NAME --confirm NAME")
    remote = Remote(cfg)
    target = remote.path("packages", "hermes", f"{args.name}.yaml")
    remote.run(f"rm -f {shlex.quote(target)}")
    ok, errors = check_config(cfg)
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
    ok, errors = check_config(cfg)
    print("Config check: valid" if ok else f"Config check: invalid\n{errors}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    p = sub.add_parser("setup")
    p.add_argument("--confirm", default="")
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
