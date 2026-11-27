---
name: to-markdown
description: Converts PDF, Word, PowerPoint, Excel, HTML, EPUB, CSV, JSON, ZIP and other files to Markdown with markitdown so a text model can read them.
metadata:
  keywords:
    - convert to markdown
    - read pdf
    - docx
    - pptx
    - xlsx
    - markitdown
    - file to text
---

# To Markdown

[markitdown](https://github.com/microsoft/markitdown) (Microsoft, MIT) turns
documents into Markdown that keeps headings, lists, tables and links. Use it
when a file is not plain text and you, or a model without vision, need to read
it. It also gives a vision model a text version to check what it sees.

## When to use

- The user attaches or points to a `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.xls`,
  `.html`, `.epub`, `.msg`, `.ipynb`, `.zip`, `.csv` or `.json` file.
- A web page should be read as clean Markdown instead of raw HTML.

Studio already converts these attachments when markitdown is installed: the
attachment then says "Markdown copy for reading: <path>.md". Read that copy
instead of converting again.

## How to run

The version is pinned. `uvx` runs it without installing anything globally.

```bash
uvx --from 'markitdown[all]==0.1.9' markitdown <file> -o /tmp/to-markdown/<name>.md
# no uv: pip install 'markitdown[all]==0.1.9' && markitdown <file> -o <out>.md
# a page: download it first, then convert the .html file
```

There is also an MCP server, `markitdown-mcp` (tool `convert_to_markdown`,
takes `http:`, `https:`, `file:` or `data:` URIs). Studio lists it under
MCP → Directory → Recommended.

## Procedure

1. Convert to a file outside the user's folders, then read the file.
2. For a large result, read the headings first and then the sections you need.
3. Quote tables and numbers from the Markdown exactly.

## Pitfalls

- Scanned PDFs have no text layer; the output will be nearly empty. Say so and
  ask whether to OCR it.
- Images inside documents are not described unless an LLM client is set up;
  only their alt text comes through.
- markitdown reads whatever path or URL it is given. Only convert files the
  user gave you or asked about.
