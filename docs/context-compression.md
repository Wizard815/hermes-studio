# Fewer tokens for local models

Local models on llama.cpp (through Argos) have small context windows and slow
prompt processing. These pieces cut what goes into, and out of, the model.
Each one is lossless for code, or only touches prose.

| Tool | Cuts | How | In Studio |
| --- | --- | --- | --- |
| tokensave (MIT) | input: exploring code | a local code graph answers "where is X, who calls it" in one call instead of many file reads | MCP directory, Recommended; `/code-map` skill |
| repomix `--compress` (MIT) | input: reading a repo | tree-sitter keeps signatures and structure, drops bodies (about 70%) | Add a repo; `/repo-pack`; MCP |
| markitdown (MIT) | input: documents and pages | HTML, PDF and Office become plain Markdown (raw HTML is often 3 to 10 times bigger) | attachments; `/to-markdown`; MCP |
| caveman (Apache-2.0) | output | a terse voice that keeps every fact; about 1.4 to 2.4 times cheaper output in the paper it cites | `/caveman`, `/ultracave` |
| Hermes context compression | history | summarises old turns when the window fills | built into Hermes |

## LLMLingua: evaluated, not added

[LLMLingua](https://github.com/microsoft/LLMLingua) (Microsoft, MIT) deletes
low-information tokens from a prompt. LLMLingua-2 does it with a small
token-classification model (multilingual BERT, about 180M parameters, or
XLM-RoBERTa large, about 560M), runs on CPU, and reports 2 to 5 times
compression with small quality loss on question answering and summaries.

Why it is not in the default path:

- **It is lossy per token.** It drops words, so it breaks code, JSON, paths,
  commands and numbers, which is most of what an agent reads. It is only safe
  on prose.
- **It breaks prompt caching.** Hermes keeps each conversation's prefix stable
  so llama.cpp can reuse its KV cache. Compressing the system prompt or the
  history changes the prefix and forces a full re-read, which on slow GPUs costs
  more than the tokens saved. Only new tool output at the end can be compressed.
- **It brings PyTorch.** A Python sidecar with torch (about 2 GB) beside Argos,
  which is Go. ROCm builds of torch for gfx906 are not a given; CPU is fine for
  the small model.
- **The tools above get most of the win** without losing exact text.

Where it would pay off: long natural-language tool results (web pages,
transcripts, long documents, wiki search hits) going to a small-context local
model. If that becomes a bottleneck, the plan is a small LLMLingua-2 HTTP
service next to Argos, called by Hermes only for `web_extract` and document
results over a few thousand tokens, at rate 0.5, forcing digits, URLs and code
spans to stay. Measure it with the FAITH and Argos evals before turning it on.
This is an assessment from the project's papers and docs, not a measurement on
this homelab's hardware.
