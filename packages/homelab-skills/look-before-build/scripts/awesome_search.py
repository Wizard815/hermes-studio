#!/usr/bin/env python3
"""Search curated "awesome" lists for projects that already do what you want.

Lists: selfhosted (awesome-selfhosted), mcp (awesome-mcp-servers), awesome
(sindresorhus/awesome, a list of lists) or any GitHub repo URL whose README is
a Markdown list. READMEs are cached for a week in the user's cache folder.

    awesome_search.py "photo backup" --list selfhosted
    awesome_search.py "home assistant" --list mcp --limit 15
    awesome_search.py "rust" --list awesome            # find the right sub-list
    awesome_search.py "tui" --list https://github.com/rothgar/awesome-tuis
    awesome_search.py "recipes" --list all --json

Standard library only. Exits 0 with "no matches" when nothing fits.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

LISTS = {
    "selfhosted": "https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted/master/README.md",
    "mcp": "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md",
    "awesome": "https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md",
}
CACHE_TTL = 7 * 24 * 3600
ITEM_RE = re.compile(r"^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$")
HEADING_RE = re.compile(r"^(#{2,4})\s+(.*)$")
TAG_RE = re.compile(r"<[^>]+>")
BADGE_RE = re.compile(r"\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
STOP = {"a", "an", "the", "for", "to", "of", "and", "or", "with", "in", "on", "my", "app", "tool"}


def cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    path = Path(base) / "awesome-lists"
    path.mkdir(parents=True, exist_ok=True)
    return path


def raw_readme_urls(url: str) -> list[str]:
    """Raw README candidates for a GitHub repo URL (or the URL itself if it is already raw)."""
    if "raw.githubusercontent.com" in url or url.endswith(".md"):
        return [url]
    m = re.match(r"https?://github\.com/([^/]+)/([^/#?]+)", url)
    if not m:
        return [url]
    owner, repo = m.group(1), m.group(2).removesuffix(".git")
    return [f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{name}"
            for branch in ("main", "master") for name in ("README.md", "readme.md")]


def fetch(url: str, refresh: bool = False) -> str:
    if Path(url).is_file():  # a list already on disk
        return Path(url).read_text(encoding="utf-8")
    key = re.sub(r"[^A-Za-z0-9]+", "_", url)[-150:] + ".md"
    cached = cache_dir() / key
    if not refresh and cached.exists() and time.time() - cached.stat().st_mtime < CACHE_TTL:
        return cached.read_text(encoding="utf-8")
    errors = []
    for candidate in raw_readme_urls(url):
        try:
            req = urllib.request.Request(candidate, headers={"User-Agent": "awesome-search/1"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", "replace")
            cached.write_text(text, encoding="utf-8")
            return text
        except (urllib.error.URLError, TimeoutError) as exc:
            errors.append(f"{candidate}: {exc}")
    if cached.exists():
        print(f"warning: using stale cache for {url}", file=sys.stderr)
        return cached.read_text(encoding="utf-8")
    raise SystemExit("could not fetch list:\n  " + "\n  ".join(errors))


def clean(text: str) -> str:
    text = BADGE_RE.sub("", text)
    text = LINK_RE.sub(r"\1", text)
    text = TAG_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip(" -–—:")


def parse(markdown: str, list_name: str) -> list[dict]:
    items, section = [], ""
    for line in markdown.splitlines():
        h = HEADING_RE.match(line)
        if h:
            section = clean(h.group(2))
            continue
        m = ITEM_RE.match(line)
        if not m or m.group(2).startswith("#"):
            continue  # table-of-contents links point at anchors
        items.append({"name": clean(m.group(1)), "url": m.group(2), "section": section,
                      "description": clean(m.group(3)), "list": list_name})
    return items


def words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9][a-z0-9+#.-]*", text.lower()) if w not in STOP]


def score(item: dict, terms: list[str], phrase: str) -> float:
    name, section, desc = item["name"].lower(), item["section"].lower(), item["description"].lower()
    total = 0.0
    if phrase and phrase in f"{name} {desc}":
        total += 6
    for term in terms:
        if term in name:
            total += 4
        if term in section:
            total += 2
        if re.search(rf"\b{re.escape(term)}", desc):
            total += 2
    matched = sum(1 for t in terms if t in f"{name} {section} {desc}")
    return total * (matched / len(terms)) if terms else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", help="what you want to build or find, in a few words")
    ap.add_argument("--list", default="all", help="selfhosted, mcp, awesome, all, a GitHub repo URL or a local .md file")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--json", action="store_true", help="print JSON instead of text")
    ap.add_argument("--refresh", action="store_true", help="ignore the week-old cache")
    args = ap.parse_args(argv)

    if args.list == "all":
        sources = list(LISTS.items())
    elif args.list in LISTS:
        sources = [(args.list, LISTS[args.list])]
    else:
        sources = [(args.list, args.list)]
    items = []
    for name, url in sources:
        items += parse(fetch(url, args.refresh), name)

    terms, phrase = words(args.query), " ".join(words(args.query))
    ranked = sorted(((score(i, terms, phrase), i) for i in items), key=lambda pair: -pair[0])
    hits = [dict(i, score=round(s, 1)) for s, i in ranked if s > 0][: args.limit]
    if args.json:
        print(json.dumps(hits, indent=2))
    elif not hits:
        print(f"no matches for {args.query!r} in {', '.join(n for n, _ in sources)} ({len(items)} entries searched)")
    else:
        for hit in hits:
            print(f"[{hit['list']}] {hit['name']} - {hit['url']}")
            print(f"    {hit['section']}: {hit['description'][:240]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
