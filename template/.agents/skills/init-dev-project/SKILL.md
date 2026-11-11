---
name: init-dev-project
description: "Use when the user wants to bootstrap a new software project with the personal dev infrastructure (Backlog.md, GitNexus, committable vector RAG for docs, optional LightRAG doc-graph, env-tools MCP, shared agent rules) — scaffolds folder structure, surveys the tech stack, installs the environment cross-platform, and wires everything together. Works both when the infra becomes the project root and when it's added as a subfolder inside an existing project. Examples: \"init this project\", \"set up dev infra here\", \"bootstrap a new project with my usual tooling\""
---

# init-dev-project

Deploys the personal development infrastructure from the ProjectTemplate template (below — `<template>`;
its source of truth is `<template>/README.md`): Backlog.md, GitNexus, a committable vector RAG
for the documentation, an optional LightRAG graph, MCP tools for working with the environment,
a cross-platform bootstrap and a shared rules file for agents.

> This skill is the last step in the chain (`RAG` → `MCP env-tools` → `bootstrap` → `init-dev-project`).
> It invents nothing new: it copies and wires together the ready-made pieces of the template.
> If you do not know where the template is (another machine, no `F:\ProjectTemplate`), ask the user where
> the current copy lives before continuing. In ProjectHub the same is done by the "Initialize"
> window with the built-in template — this skill is for setting up by hand.

## Step 0 — where we are and what already exists

1. Determine the target directory — usually the current working directory.
2. Check `<template>` — if the path does not exist, ask the user where to look for the template.
3. Check what is already in the target directory: an existing `package.json`, `.git`, `backlog/`
   (including `backlog/docs/`) — do not overwrite anything silently, only add or merge.

## Step 1 — questions

Ask the user with `AskUserQuestion` (briefly, do not turn it into a questionnaire):

1. **Is the infrastructure the project root, or is it added as a subfolder** of an existing
   project? If a subfolder — what it is called (for example `dev-infra/`) and where the project root is
   relative to it. This defines `projectRoot` in `infra.config.json` (see step 3).
2. **The project's main language/runtime** — Node.js/TypeScript, Python, Go, Rust, not decided yet /
   infrastructure only (no code). It only affects `scripts/bootstrap/stack.json` — the
   RAG/MCP infrastructure itself always runs on Node.js regardless of the project stack.
3. **The project name** for Backlog.md — by default the name of the project root folder.
4. **The language of the agent rules and documentation** — English (default) or Russian. Russian means
   `"locale": "ru"` in `infra.config.json` and the translated files from `<template>/locales/ru/` (step 3).
5. **Is LightRAG needed** (an entity/relation graph of the documentation)? **The default is no.**
   Warn explicitly: it is Python plus a local LLM through Ollama (several GB of disk, slow
   indexing — minutes per document, not seconds). Enable it only if the user
   knowingly agreed; do not offer it as a matter-of-course addition.
6. **Is a browser for visual UI checks needed** (Playwright MCP, the `playwright` feature)? **The default is no.**
   Ask only if the project has a web interface. The feature adds `@playwright/mcp` (headless, in-memory profile,
   system Chrome) to both MCP configs and `.playwright-mcp/` to `.gitignore` (rule 26 of `infra-dev.md`).
   Do not offer computer use (the `computerUse` feature) — only on a separate explicit request (rule 24).
7. If the directory already has code — **index it with GitNexus right away?** (yes/no).
   Skip the question for an empty project.

## Step 2 — git and Backlog.md

```bash
git init   # if there is no .git in the project root yet
npx --yes backlog.md init "<project name>" --agent-instructions agents --defaults
```

Run it **in the project root** (not necessarily the current directory if the infra is a subfolder).
`--agent-instructions agents` writes the Backlog.md block into **`AGENTS.md`** (not `AGENT.md` —
that is what both Backlog.md and GitNexus call the shared rules file). If `.git` was not created
(the user explicitly asked for no git) — add `--no-git`.

## Step 3 — copy the infrastructure and configure it

Copy as is into the infrastructure target directory (the project root or the chosen
subfolder — do not confuse it with the project root from step 2):

| From `<template>/...` | To |
|---|---|
| `infra-dev.md` | `./infra-dev.md` |
| `locales/ru/infra-dev.md` (only for Russian rules, question 4) | `./locales/ru/infra-dev.md` |
| `scripts/config.mjs`, `scripts/setup.mjs`, `scripts/sync-agent-rules.mjs`, `scripts/web.mjs`, `scripts/validate-docs.mjs`, `scripts/memory-rules.mjs`, `scripts/doc-rules.mjs`, `scripts/backlog-id-rules.mjs`, `scripts/task-merge-driver.mjs`, `scripts/task-merge-rules.mjs`, `scripts/generated-merge.mjs`, `scripts/set-doc-section.mjs`, `scripts/policy-check.mjs`, `scripts/policy-rules.mjs`, `scripts/*.test.mjs` | `./scripts/` |
| `scripts/rag/*.mjs` | `./scripts/rag/` |
| `scripts/env/*.mjs` | `./scripts/env/` |
| `scripts/gitnexus/gitnexus.mjs` | `./scripts/gitnexus/` |
| `scripts/git-hooks/*` (pre-commit, commit-msg, post-commit, post-merge, post-rewrite, install.mjs, hooks.test.mjs) | `./scripts/git-hooks/` |
| `rag-control-queries.json` (a sample; the project replaces the queries with its own after the first guides) | `<project root>/` |
| `.gitnexusignore`, `.ignore` | `<project root>/` (what GitNexus does not index; the idea bin is hidden from the agent's search) |
| `.claude/agents/critic.md` (for Russian — from `locales/ru/.claude/agents/`) | `<project root>/.claude/agents/` (the critic subagent for outward texts) |
| `.claude/skills/init-dev-project/`, `.agents/skills/init-dev-project/` (for Russian — from `locales/ru/`) | `<project root>/` (this skill for Claude Code and Antigravity) |
| `backlog/idea-bin/README.md` | `<project root>/backlog/idea-bin/` — after `backlog init` (step 2), plus a `.gitkeep` in empty `backlog/*` folders |
| `scripts/bootstrap/bootstrap.mjs`, `scripts/bootstrap/stack.json` | `./scripts/bootstrap/` |
| `scripts/lightrag/*` (only if LightRAG is enabled in step 1) | `./scripts/lightrag/` |
| `scripts/computer-use/computer-use-bridge.mjs` (only if the user explicitly asked for `computerUse`) | `./scripts/computer-use/` |
| `.gitattributes`, `.claude/settings.json` | `<project root>/` (LF/CRLF by file type; the Claude Code permissions allowlist) |
| `start-web.bat`, `start-web.sh` | `./` (next to the infrastructure package.json) |

The template guides from `backlog/docs/` (`doc-1` deployment, `doc-2` RAG, `doc-3` task statuses,
`doc-4` choosing the assignee) are **not copied as files** — the `doc-N` numbers in the new project
would collide. Recreate the ones you need in the project root after `backlog init` with
`npx backlog.md doc create "<Title>" -t guide` (or MCP `document_create`) using the content from the
template. All project documentation lives inside `backlog/docs/`/`backlog/decisions/`;
the project must not have a separate top-level `docs/`, and document files are created
only through the CLI/MCP (rule 14 of `infra-dev.md`).

Add the hand-over statuses to the project root `backlog/config.yml` (the `statuses` key
is not edited through `backlog config set`; edit the file directly):
`statuses: ["To Do", "In Progress", "InProgress(Human)", "Review", "Review(Human)", "Done"]`.

`package.json` — if the target directory already has one, add the `scripts`/`dependencies`
from `<template>/package.json` to it (without replacing existing scripts of the same name without
a warning; `prepare`, `install-hooks`, `test`, `lint:docs`, `check-index` and the
`gray-matter` dependency are mandatory); if not — copy it as is. `.gitignore` — add the entries
from the same place (node_modules/, .rag-cache/, .env-state/, .env*, dist/, scripts/lightrag/.venv/,
__pycache__/); **do not add** `.rag-index/` and `.lightrag-index/` to `.gitignore` — they must
be committed.

Then configure it (one command instead of editing `infra.config.json`/`.mcp.json` by hand):

```bash
node scripts/setup.mjs --project-root <path-from-infra-to-project-root> \
  --features docsRag,envTools,backlogMcp,bootstrap,gitnexus[,lightrag][,playwright] --no-interactive
npm install
```

`--project-root` is `.` if the infrastructure itself is the root (the usual case), or a
relative path upwards (`..`, `../..`) if it is added as a subfolder. List `--features`
explicitly according to the answers in step 1 (`lightrag` and `playwright` only if the user agreed; do not enable `computerUse`
without a separate explicit request).
`setup.mjs` writes `infra.config.json` itself, syncs `.mcp.json` (Claude Code) and
`.agents/mcp_config.json` (Google Antigravity) **in the project root** (not in the infra subfolder)
with correct relative paths to the scripts, and connects the git hooks through
`core.hooksPath` (`npm install` does the same through `prepare`). The `gitnexus` feature needs
the global CLI: `npm i -g gitnexus` — if it is missing, `setup.mjs` will say so.
For Russian rules add `"locale": "ru"` to `infra.config.json` (`setup.mjs` keeps manual keys).

## Step 4 — environment

```bash
node scripts/bootstrap/bootstrap.mjs
```

If the user chose a language that has no entry in the template `stack.json` (by default
it only has `git` and `node` — the infrastructure itself needs them), add to
`./scripts/bootstrap/stack.json` → `tools` before running it:

| Language | Entry for `stack.json` |
|---|---|
| Python | `{ "name": "python", "check": "python --version", "winget": "Python.Python.3.12", "brew": "python@3.12", "apt": "python3 python3-pip", "dnf": "python3", "pacman": "python" }` |
| Go | `{ "name": "go", "check": "go version", "winget": "GoLang.Go", "brew": "go", "apt": "golang-go", "dnf": "golang", "pacman": "go" }` |
| Rust | `{ "name": "rust", "check": "rustc --version", "winget": "Rustlang.Rustup", "brew": "rust", "apt": "rustc cargo", "dnf": "rust cargo", "pacman": "rust" }` |
| Node.js/TypeScript | add nothing — `node` is already in the base list |

`bootstrap.mjs` is cross-platform: it detects the OS and the available package manager
(`winget`/`brew`/`apt`/`dnf`/`pacman`) itself — no need to ask the user about the OS again.

## Step 5 — GitNexus (if there is code)

If in step 1 the user asked to index right away (or the directory already has code),
run **in the project root**:

```bash
gitnexus analyze --skip-agents-md --skip-skills   # the global CLI (npm i -g gitnexus); after that the post-commit hook updates the index itself
```

The flags are mandatory: without them `analyze` appends its section to `CLAUDE.md`/`AGENTS.md` on every run
and puts skills into `.claude/skills/gitnexus`. What to index is set by `.gitnexusignore` (copied in
step 3). Run it **before** step 7 (sync-rules) — the order "external tools first, our
sync-rules last" guarantees that our section is appended, not lost, and does not lose anyone else's.

## Step 6 — the RAG index (and optionally LightRAG)

```bash
npm run index-docs        # index over backlog/docs/, backlog/decisions/
```

If LightRAG is enabled, it is a separate, explicitly heavy step — do not run it silently together with
the rest without warning about the time and disk space:

```bash
npm run lightrag-setup    # ONE-TIME: venv, lightrag-hku, Ollama models (several GB)
npm run lightrag-index    # build the graph — minutes, not seconds, per document
```

`lightrag-setup` checks Ollama and the required models itself — if Ollama is not installed or not
running, the script stops with clear instructions instead of hanging.

## Step 7 — send out the rules

```bash
node scripts/sync-agent-rules.mjs   # infra-dev.md → CLAUDE.md/GEMINI.md/AGENTS.md and .agents/rules/infra-dev.md in the project root
npm run lint:docs                   # frontmatter/dates/images, sections, [[id]] links, duplicate ids + index freshness — must be green
npm test                            # tests of hooks, merge drivers, linters, sync-rules — must be green
npm run rag-check                   # search control queries (if rag-control-queries.json is filled in for the project)
```

`sync-agent-rules.mjs` takes the rules from `infra-dev.md` (with `"locale": "ru"` — from
`locales/ru/infra-dev.md`) and cuts out `<!-- if:feature -->` blocks according to the enabled features and the
`ruleSets` rule sets from `infra.config.json` (without the key — all sets: `lang-ru`, `windows`, `data-driven`,
`code-ts`); if the project is not on Windows, not data-driven or not answered in Russian — ask the user and set `ruleSets`.
`pre-commit` compares the generated files with the rules source using the git index (`--check --staged`).

Check that the hooks are connected: `git config core.hooksPath` → `scripts/git-hooks` (or the path
through the infra subfolder). If the project root became a git repository after `npm install` —
`npm run install-hooks`.

## Step 8 — report to the user

Briefly list: what was created; that the agent/IDE must be restarted to pick up
`.mcp.json`/`.agents/mcp_config.json` (`docs-rag`, `env-tools`, `backlog`, `gitnexus`, and if chosen —
`docs-graph`, `playwright`); which git hooks are connected and what they do (`pre-commit`: lint:docs and the rules check;
`commit-msg`: no AI attribution; `post-commit`: GitNexus reindexing); how to start the Backlog.md/GitNexus web UIs
(`node scripts/web.mjs start` or `start-web.bat`/`start-web.sh` in the infrastructure
root); and what is left to the user's discretion (for example, LightRAG if they did not
enable it in step 1 — it can be added later with `node scripts/setup.mjs`).

The skill **does not create** ProjectHub roles as native subagents or terminal session hooks (rule 25 of `infra-dev.md`):
`.claude/agents/*.md`, `.codex/agents/*.toml`, `.projecthub/hooks/projecthub-hook.mjs` and the hook entries
in `.claude/settings.json` / `.codex/hooks.json` are generated by ProjectHub (Roles → "Sync to project"),
which marks the files with `projecthub:generated`. When the skill runs again in an existing project, do not overwrite
or delete these files, merge `.claude/settings.json` instead of replacing it; `setup.mjs` and `sync-agent-rules.mjs`
do not touch them. The hook token lives only in the `PROJECTHUB_HOOK_TOKEN` environment variable and is never written to files.
