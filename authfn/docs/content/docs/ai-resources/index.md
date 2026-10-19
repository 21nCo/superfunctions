---
title: AI Resources
description: Give LLM-based coding assistants current AuthFn context through the generated llms.txt files.
---

# AI Resources

This site publishes generated, LLM-friendly context so an assistant can answer questions about AuthFn from the current documentation instead of guessing.

## What's available

| Resource | Use it when… |
| --- | --- |
| [llms.txt](./llms-txt) | You want a page index or a single full-text context file for any assistant that accepts a URL or pasted context. |
| [Cursor](./cursor) | You're on Cursor and want a project rule that points at the context file. |
| [Claude](./claude) | You're on Claude Desktop or Claude Code. |
| [Codex / Droid](./codex) | You use an AGENTS.md-aware tool. |

Both files are generated from `content/docs/**` (and the configured API material) when the docs are built, so they follow the published pages. AuthFn does not ship an MCP server or hosted skill packs; static context files do not authenticate an assistant or give it live access to your deployment.

## Quick start

Point your assistant at the full-text file:

```
https://authfn.com/docs/llms-full.txt
```

Use the [short index](https://authfn.com/docs/llms.txt) when the context budget is small, then fetch only the linked pages you need.
