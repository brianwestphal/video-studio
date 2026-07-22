# Codex Project Guidance

`CLAUDE.md` is the shared source of truth for this repository's engineering
rules. Read it completely before making or reviewing changes, and follow it as
if its contents appeared here. The filename reflects the project's history;
the instructions apply equally to Codex.

## Codex workflow

- Read `docs/ai/codebase-map.md` and `docs/ai/requirements-summary.md` early in
  a fresh session when the task involves implementation, architecture, or
  requirements.
- Project workflows are exposed as skills under `.agents/skills/`. Use a skill
  when the user names it or the request clearly matches its description.
- The project-specific skill adapters delegate to `.claude/skills/`, which is
  the canonical source for workflows shared by Claude and Codex. When changing
  a shared workflow, edit the canonical file and keep the adapter metadata in
  sync.
- Claude tool names in shared workflow documents describe capabilities, not
  required product-specific tools: use Codex's equivalent file search, shell,
  editing, web, connector, or collaboration capability. If a named connector
  is unavailable, use the documented local API fallback where one exists.
- Keep durable repository guidance synchronized between this adapter and
  `CLAUDE.md`. Provider-specific configuration belongs in its provider's
  directory; shared engineering rules belong in `CLAUDE.md`.

## Verification

For code changes, run `npm run check` before finishing unless the task is
read-only or the command is blocked by the environment. Report any skipped or
failed gate explicitly.

<!-- hotsheet:begin section=claude-adapter v=1 -->
## Shared Project Guidance (CLAUDE.md)

`CLAUDE.md` is the shared source of truth for this repository's engineering rules. Read it completely before making or reviewing changes, and follow it as if its contents appeared here. The filename reflects the project's history; the instructions apply equally to this tool.

- Project workflows are exposed as skills under `.agents/skills/`. Use a skill when the user names it or the request clearly matches its description.
- The skill adapters delegate to `.claude/skills/`, the canonical source for workflows shared across AI tools. When changing a shared workflow, edit the canonical file and keep the adapter metadata in sync.
- Claude tool names in shared documents describe capabilities, not required product-specific tools — use this tool's equivalent file-search, shell, editing, or web capability.
- Keep durable repository guidance in `CLAUDE.md`; provider-specific configuration belongs in its provider's directory.
<!-- hotsheet:end section=claude-adapter -->
