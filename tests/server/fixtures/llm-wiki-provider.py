"""Drives Studio's LLM wiki memory provider (packages/server/src/assets/hermes-plugins/llm_wiki) the way
Hermes does, against the stub wiki. Usage: python3 llm-wiki-provider.py <wiki-url>. Prints JSON."""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/server/src/assets/hermes-plugins"))
import llm_wiki  # noqa: E402

url = sys.argv[1]
os.environ.pop("LLM_WIKI_TOKEN", None)
os.environ.pop("LLM_WIKI_URL", None)
out = {}
with tempfile.TemporaryDirectory() as tmp:
    def home(name, token, extra=""):
        path = Path(tmp) / name
        path.mkdir()
        (path / "config.yaml").write_text(f"memory:\n  provider: llm_wiki\n  llm_wiki:\n    url: {url}/family-mcp/\n{extra}", encoding="utf-8")
        if token:
            (path / ".env").write_text(f"OTHER=1\nLLM_WIKI_TOKEN={token}\n", encoding="utf-8")
        return path

    def provider(path, session, **kwargs):
        p = llm_wiki.LlmWikiMemoryProvider()
        p.initialize(session, hermes_home=str(path), platform="cli", **kwargs)
        return p

    sam_home, wizard_home, house_home = home("sam", "t-sam"), home("wizard", "t-wizard"), home("house", "t-house")
    sam, wizard, house = provider(sam_home, "s1"), provider(wizard_home, "w1"), provider(house_home, "h1")
    # Two profiles in one process: each instance keeps its own token and identity.
    out["identities"] = {"sam": sam._who, "wizard": wizard._who, "house": house._who}
    out["settings_url"] = llm_wiki.resolve_settings(sam_home)["url"]
    question = "What about the Lisbon trip, the wedding quilt and RaidLab?"
    out["recall"] = {"sam": sam.prefetch(question, session_id="s1"), "wizard": wizard.prefetch(question, session_id="w1"), "house": house.prefetch(question, session_id="h1")}
    out["second_recall_has_context"] = "# Context for" in sam.prefetch(question, session_id="s1")
    out["trivial"] = sam.prefetch("ok", session_id="s1")
    out["house_read_private"] = json.loads(house.handle_tool_call("llm_wiki_read", {"path": "people/wizard/wiki/1-projects/Surprise trip.md"}))
    out["house_read_private_virtual"] = json.loads(house.handle_tool_call("llm_wiki_read", {"path": "wiki/1-projects/Surprise trip.md"}))
    out["house_search_private"] = json.loads(house.handle_tool_call("llm_wiki_search", {"query": "Lisbon"}))
    out["wizard_read"] = json.loads(wizard.handle_tool_call("llm_wiki_read", {"path": "wiki/1-projects/Surprise trip.md"}))
    out["remember"] = {
        "sam": json.loads(sam.handle_tool_call("llm_wiki_remember", {"text": "Ordered\n the cotton for the quilt", "section": "decisions"})),
        "house": json.loads(house.handle_tool_call("llm_wiki_remember", {"text": "Bins go out on Tuesday", "section": "follow_ups"})),
        "capture": json.loads(sam.handle_tool_call("llm_wiki_capture", {"title": "Quilt pattern", "content": "Log cabin, 12 blocks."})),
        "secret": json.loads(sam.handle_tool_call("llm_wiki_remember", {"text": "router password: hunter2hunter2"})),
    }
    sam.on_memory_write("add", "user", "Sam prefers cotton over linen")
    sam.on_memory_write("remove", "user", "ignored")
    sam.on_turn_start(1, "Help me plan the quilt borders")
    sam.on_session_end([])
    sub = provider(sam_home, "s2", agent_context="subagent")
    out["subagent_remember"] = json.loads(sub.handle_tool_call("llm_wiki_remember", {"text": "should not land"}))
    sub.on_session_end([{"role": "user", "content": "nothing from a subagent"}])
    quiet = provider(home("quiet", "t-sam", "    recall: false\n    remember: false\n"), "q1")
    out["quiet_recall"] = quiet.prefetch(question, session_id="q1")
    quiet.on_memory_write("add", "user", "not mirrored")
    nobody_home = home("nobody", "")
    os.environ["HERMES_HOME"] = str(nobody_home)
    out["available_without_token"] = llm_wiki.LlmWikiMemoryProvider().is_available()
    os.environ["HERMES_HOME"] = str(sam_home)
    out["available_with_token"] = llm_wiki.LlmWikiMemoryProvider().is_available()
    out["tools"] = {"member": [t["name"] for t in sam.get_tool_schemas()], "house_person": "person" in house.get_tool_schemas()[2]["parameters"]["properties"], "member_person": "person" in sam.get_tool_schemas()[2]["parameters"]["properties"]}
    out["system_prompt"] = {"sam": sam.system_prompt_block(), "house": house.system_prompt_block()}
print(json.dumps(out))
