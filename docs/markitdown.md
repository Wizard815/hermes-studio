# Markdown copies of attachments

When you attach a PDF, Word, PowerPoint, Excel, HTML, EPUB, Outlook `.msg`,
notebook, RTF or ODT file, Studio converts it with
[markitdown](https://github.com/microsoft/markitdown) 0.1.9 (MIT) and saves
`<file>.md` next to the upload. The model is told
`Markdown copy for reading: <path>.md` under the attachment, so a text-only
model can read the document and a vision model gets a text check of what it
sees.

The Docker image installs markitdown in its own venv (`/opt/markitdown`). On
other hosts Studio uses `markitdown` if it is on PATH, else
`uvx --from markitdown[all]==0.1.9 markitdown`. If neither runs, attachments
are passed as before.

The `/to-markdown` skill and the markitdown MCP server do the same for files
and pages the agent finds itself. The browser tool
`ekko_studio_browser_read_page` uses it to turn the page open in the Browser
panel into Markdown (browser-panel.md).

## Turn it off

`STUDIO_MARKITDOWN=0` on the container. Build without it:
`docker build --build-arg INSTALL_MARKITDOWN=0 .`

## What goes wrong

- **No Markdown copy appears.** markitdown is not installed, the file is over
  50 MB, or the conversion took more than two minutes. Studio's log says which
  (`[markitdown]`).
- **The copy is almost empty.** A scanned PDF has no text layer. markitdown does
  not OCR; ask the agent to OCR it.
- **Uploads feel slow.** Conversion runs before the upload finishes. Large
  spreadsheets take the longest; turn it off if that matters more.
