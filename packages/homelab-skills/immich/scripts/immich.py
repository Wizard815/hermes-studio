#!/usr/bin/env python3
"""Read the user's own Immich library: search, today's memories, people, albums.

    immich.py search "birthday cake" --after 2024-01-01
    immich.py search --people Robin --place Paris --videos
    immich.py memories
    immich.py people
    immich.py albums
    immich.py search "snow" --json

Needs IMMICH_URL and IMMICH_API_KEY (from the Hermes profile's .env).
Standard library only. Read only: it never changes the library.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class ImmichError(Exception):
    pass


class Immich:
    def __init__(self, url: str, key: str, public: str | None = None):
        if not url or not key:
            raise ImmichError("IMMICH_URL and IMMICH_API_KEY must be set (in the profile's .env).")
        self.base = url.rstrip("/").removesuffix("/api")
        self.public = (public or self.base).rstrip("/")
        self.key = key

    def req(self, method: str, path: str, body: object | None = None):
        data = None if body is None else json.dumps(body).encode()
        r = urllib.request.Request(self.base + "/api" + path, data=data, method=method,
                                   headers={"x-api-key": self.key, "Accept": "application/json",
                                            **({"Content-Type": "application/json"} if data else {})})
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                text = resp.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            msg = ""
            try:
                m = json.loads(e.read().decode()).get("message", "")
                msg = ", ".join(m) if isinstance(m, list) else str(m)
            except Exception:
                pass
            if e.code == 401:
                raise ImmichError("Immich refused the key (401). Make a new one: Account settings → API keys.")
            if e.code == 403:
                raise ImmichError(f"The key is missing a permission ({msg or '403'}). See the skill's Setup.")
            if e.code == 400 and "smart search" in msg.lower():
                raise ImmichError("Immich's smart search is off. Search with --people, --place or dates instead.")
            raise ImmichError(f"Immich answered {e.code}{': ' + msg if msg else ''}.")
        except urllib.error.URLError as e:
            raise ImmichError(f"Couldn't reach Immich at {self.base} ({e.reason}).")

    def ref(self, a: dict) -> dict:
        e = a.get("exifInfo") or {}
        place = ", ".join(x for x in (e.get("city"), e.get("state"), e.get("country")) if x)
        taken = str(e.get("dateTimeOriginal") or a.get("localDateTime") or a.get("fileCreatedAt") or "")[:16].replace("T", " ")
        out = {"id": a.get("id"), "kind": "video" if a.get("type") == "VIDEO" else "photo", "taken": taken,
               "link": f"{self.public}/photos/{a.get('id')}"}
        if place:
            out["place"] = place
        people = [p.get("name") for p in a.get("people") or [] if p.get("name")]
        if people:
            out["people"] = people
        if e.get("description"):
            out["caption"] = str(e["description"])[:200]
        return out

    def person_ids(self, names: list[str]) -> tuple[list[str], list[str]]:
        ids, unknown = [], []
        for n in names[:5]:
            found = self.req("GET", "/search/person?name=" + urllib.parse.quote(n)) or []
            hit = next((p for p in found if str(p.get("name", "")).lower() == n.lower()), found[0] if found else None)
            (ids.append(hit["id"]) if hit else unknown.append(n))
        return ids, unknown

    def search(self, query: str = "", people: list[str] | None = None, place: str = "", after: str = "",
               before: str = "", videos: bool | None = None, favorites: bool = False, limit: int = 12) -> dict:
        ids, unknown = self.person_ids(people or [])
        f: dict = {"size": max(1, min(100, limit)), "withExif": True}
        if ids:
            f["personIds"] = ids
        if after:
            f["takenAfter"] = after + "T00:00:00.000Z"
        if before:
            f["takenBefore"] = before + "T23:59:59.999Z"
        if favorites:
            f["isFavorite"] = True
        if videos is not None:
            f["type"] = "VIDEO" if videos else "IMAGE"
        if query or place:
            r = self.req("POST", "/search/smart", {**f, "query": " ".join(x for x in (query, place and f"in {place}") if x)})
        else:
            r = self.req("POST", "/search/metadata", {**f, "withPeople": True, "order": "desc"})
        items = ((r or {}).get("assets") or {}).get("items") or []
        out = {"photos": [self.ref(a) for a in items[: f["size"]]]}
        if unknown:
            out["note"] = "Immich has no face named " + ", ".join(unknown) + " (names come from its People page)."
        return out

    def memories(self, today: dt.date | None = None) -> list[dict]:
        today = today or dt.date.today()
        r = self.req("GET", "/memories?for=" + urllib.parse.quote(today.isoformat() + "T00:00:00.000Z")) or []
        out = []
        for m in r:
            assets = m.get("assets") or []
            if not assets:
                continue
            year = (m.get("data") or {}).get("year")
            out.append({"year": year, "years_ago": today.year - year if year else None, "count": len(assets),
                        "photos": [self.ref(a) for a in assets[:6]]})
        return sorted(out, key=lambda x: -(x["year"] or 0))

    def people(self) -> list[str]:
        r = self.req("GET", "/people?withHidden=false&size=500") or {}
        return sorted({p["name"] for p in r.get("people") or [] if p.get("name")})

    def albums(self) -> list[dict]:
        return [{"name": a.get("albumName"), "count": a.get("assetCount"), "shared": bool(a.get("shared")),
                 "link": f"{self.public}/albums/{a.get('id')}"} for a in self.req("GET", "/albums") or []]


def show(out, as_json: bool) -> None:
    if as_json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return
    if isinstance(out, dict) and "photos" in out:
        for p in out["photos"]:
            extra = " · ".join(x for x in (p.get("place"), ", ".join(p.get("people", []))) if x)
            print(f"{p['taken']}  {p['kind']}  {extra}\n  {p['link']}")
        if not out["photos"]:
            print("no matches")
        if out.get("note"):
            print(out["note"])
    elif isinstance(out, list) and out and isinstance(out[0], dict) and "years_ago" in out[0]:
        for m in out:
            print(f"{m['years_ago']} years ago ({m['year']}): {m['count']} photos")
            for p in m["photos"]:
                print(f"  {p['link']}")
    elif isinstance(out, list) and out and isinstance(out[0], dict):
        for a in out:
            print(f"{a['name']} ({a['count']}){' shared' if a['shared'] else ''}  {a['link']}")
    elif isinstance(out, list):
        print("\n".join(out) if out else "nothing yet")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query", nargs="?", default="")
    s.add_argument("--people", nargs="*", default=[])
    s.add_argument("--place", default="")
    s.add_argument("--after", default="")
    s.add_argument("--before", default="")
    s.add_argument("--videos", action="store_true", default=None)
    s.add_argument("--photos", dest="videos", action="store_false")
    s.add_argument("--favorites", action="store_true")
    s.add_argument("--limit", type=int, default=12)
    for name in ("memories", "people", "albums"):
        sub.add_parser(name)
    for p in sub.choices.values():
        p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        im = Immich(os.environ.get("IMMICH_URL", ""), os.environ.get("IMMICH_API_KEY", ""), os.environ.get("IMMICH_PUBLIC_URL"))
        if a.cmd == "search":
            out = im.search(a.query, a.people, a.place, a.after, a.before, a.videos, a.favorites, a.limit)
        else:
            out = getattr(im, a.cmd)()
    except ImmichError as e:
        print(e, file=sys.stderr)
        return 1
    show(out, a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
