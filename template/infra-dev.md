# infra-dev — rules for working with the project's local infrastructure

> This file is the source of truth. It is included as a section in `CLAUDE.md`, `GEMINI.md` and `AGENTS.md`,
> and copied in full to `.agents/rules/infra-dev.md` (Google Antigravity workspace rules)
> by `npm run sync-rules` (the `scripts/sync-agent-rules.mjs` script). Edit only here and
> rerun the sync — do not edit the sections in the agent rule files or
> `.agents/rules/infra-dev.md` directly: the next `sync-rules` overwrites them.
>
> The rules below are common to any project built on this template (collected from live projects:
> ProxiHorror, ProjectHub, WorldSim, PlatPhas). Specifics of a particular engine or stack (Godot,
> Blender, Electron, Phaser and so on) do not belong here — the project describes them itself: in a
> separate `CLAUDE.md` section outside the `infra-dev` markers or in `backlog/docs/` documents.
<!-- if:subfolder -->
>
> The template infrastructure lives in the `{{infraDir}}` subfolder of the project: run the `npm run …` and
> `node scripts/…` commands from this file in that folder (or `npm --prefix {{infraDir}} run …`).
<!-- endif -->

## What is here and why

| Tool | What for | When to use |
|---|---|---|
| **Git** | version control | always |
| **Git hooks** (`scripts/git-hooks/`, `npm run install-hooks`) | `pre-commit` — documentation validation and RAG index freshness; `commit-msg` — rejects AI attribution in messages; `post-commit` — self-healing GitNexus reindexing | installed automatically on `npm install` (`prepare`); do not bypass with `--no-verify` unless the user explicitly asks |
| **Backlog.md** (`backlog/`, MCP `backlog`) | tasks, milestones, decisions, project docs | check before starting work on a task; create a task, not just code; manage tasks through the native MCP server `backlog mcp start`, not only the CLI |
| **GitNexus** (MCP) | code graph: calls, dependencies, impact analysis | before a refactor or edit — check what the change affects; `detect_changes` before a commit |
| **Vector RAG** (`docs-rag`, MCP) | semantic search over the markdown documentation (`backlog/docs/`, `backlog/decisions/`) | before answering a question about architecture or conventions — call `search_docs` instead of answering from memory |
| **Documentation validators** (`npm run lint:docs` = `scripts/validate-docs.mjs` + `scripts/rag/check-index.mjs`) | frontmatter, quoted dates, images, tables, sections, `[[id]]` links and anchors; unique `task/doc/decision/m-N` numbers and a file-name number that matches the `id`; format, secrets and index of the project memory `backlog/memory/`; freshness of `.rag-index/` against `backlog/` | before every commit (`pre-commit` does it), after any edit of `backlog/docs/**`, `backlog/decisions/**` |
| **Search quality control** (`npm run rag-check` = `scripts/rag/check-quality.mjs`) | control queries from `rag-control-queries.json` must find their document in the top K | after `index-docs`, when the model or chunker changes, when search "suddenly" misses a document |
| **Critic subagent** (`.claude/agents/critic.md`) | an independent `PASS / REWRITE / DROP` verdict on text that leaves the project (to the user, a social network, a PR, release notes) | before publishing any text outside the project; do not publish without `PASS` |
| **LightRAG** (`docs-graph`, MCP) — optional | entity/relation graph of the same documentation (LLM extraction through a local Ollama) | questions about relations between concepts ("how is X related to Y") — `search_docs_graph`; enabled only if `features.lightrag = true` in `infra.config.json` | <!-- if:lightrag -->
| **env-tools** (`env-tools`, MCP) | start/stop/logs of local processes (dev server and so on), RAG index rebuild | instead of ad-hoc `Bash`/background processes, when the process must be visible to other sessions and agents |
| **Computer use** (`projecthub-computer`, MCP) — optional | `computer_*` tools (windows, accessibility tree, mouse, keyboard) through the ProjectHub proxy with HITL, an allowlist and a kill switch | only when the task needs a GUI outside the code; enabled only if `features.computerUse = true` and "Computer use" is turned on in ProjectHub (rule 24) | <!-- if:computerUse -->
| **Browser for UI checks** (`playwright`, MCP) — optional | Playwright MCP `browser_*` tools: open a project page, take a tree snapshot, click, take a screenshot; headless, in-memory profile | check the visible result of a UI change; enabled only if `features.playwright = true` (rule 26) | <!-- if:playwright -->

Google Antigravity is the second supported agent on a par with Claude Code: the same MCP servers
are connected through `.agents/mcp_config.json`, the same rules through `.agents/rules/infra-dev.md`,
and the `init-dev-project` skill is duplicated in `.agents/skills/init-dev-project/SKILL.md`
(Antigravity has its own skills folder and does not read `.claude/skills/`). All three are generated
or synced automatically (`setup.mjs`, `sync-agent-rules.mjs`) — except the skill itself: when you
edit it, sync it by hand with `.claude/skills/init-dev-project/SKILL.md`.

## Configuration: `infra.config.json`

The infrastructure can be the **project root** or a **subfolder** inside an existing
project (`projectRoot` in the config says where) — all scripts read the path from there
through `scripts/config.mjs` (Node) / `scripts/lightrag/pyconfig.py` (Python); there are no hardcoded
relative paths. Some functions are optional and are switched on or off by a flag in
`features` (only `lightrag` is off by default — Python plus a local LLM, heavy and not
needed by everyone; `gitnexus` is on and needs the `gitnexus` CLI installed globally). Change
the config with `node scripts/setup.mjs` (interactively or with the
`--project-root`/`--features` flags), not by hand: the script also syncs **both** MCP configs —
`.mcp.json` (Claude Code) and `.agents/mcp_config.json` (Google Antigravity, the same
`mcpServers` format) — with the same set of servers, according to the enabled `features`. Manual
config keys that `setup.mjs` does not ask about (for example, the path to a tool installed in a
non-standard place) are kept as they are on reconfiguration. A project can
extend the feature list with its own (engine MCP servers and so on) — following `blender`/`godot` in
ProxiHorror or `computerUse` in ProjectHub: a feature = a flag in `features` + an entry in
`buildDesiredMcpServers` + a script in `scripts/<feature>/`. Convention for manual keys: every
config key (`godotPath`, `cpuLimit`, a service address) is overridden by an environment
variable of the same name for the session; env takes precedence. Other manual keys: `"gitHooks": false` — the project has
its own hooks (husky, lefthook), and `npm install` does not touch `core.hooksPath`; `"ruleSets": [...]` —
which code-free rule sets to keep in the generated rule files (`lang-ru`, `windows`,
`data-driven`, `code-ts`; without the key all are on); `"locale": "ru"` — take the rules from the
translation `locales/ru/infra-dev.md` instead of this file. In the template `infra-dev.md` is marked up with conditions
(an `if:name` HTML comment at the end of a line or a block up to `endif`): `sync-rules` keeps such
text in `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` only when the feature or set is enabled and does not
renumber the rules. On initialization ProjectHub puts an already assembled `infra-dev.md` into the project: without
markup, in the project language, with the features and sets from the initialization window and with renumbered rules and
references to them — `ruleSets` and `locale` do not affect such a file; sets are changed by reinitializing.

## Rules

1. **Documentation is not in GitNexus and not in a separate top-level `docs/`.** GitNexus
   indexes code; all documentation lives inside `backlog/` (`backlog/docs/`,
   `backlog/decisions/`), next to the tasks. If you edit `backlog/docs/**/*.md` or
   `backlog/decisions/**/*.md`, run `npm run index-docs` after significant changes
   to update the vector index. The index (`.rag-index/`) is committed to git.
   Index freshness is checked automatically: `npm run check-index` (part of
   `npm run lint:docs` and `pre-commit`) fails if the document hash in `.rag-index/meta.json`
   does not match the current contents of `backlog/docs/`, `backlog/decisions/` and `backlog/memory/`
   (without the generated `MEMORY.md`) or the chunker version changed. The build is incremental:
   `index-docs` leaves an up-to-date index alone, and a rebuild computes embeddings only for
   new and changed chunks (`--force` recomputes everything); after a branch merge the index folder
   is built from scratch. On `git merge`/`pull` the index and `MEMORY.md` are not merged by hand: the
   `projecthub-generated` driver (installed by `npm install`) keeps our side, and the `post-merge` hook
   rebuilds them and amends the merge commit. After a fast-forward or `pull --rebase` the rebuild
   stays in the working tree — commit it. A merge stopped on a conflict in `.rag-index/` —
   `npm run merge:generated`, then `git commit`. The embedding model is the multilingual `Xenova/multilingual-e5-small`
   (documentation can be in any language); queries are encoded with the model recorded in the index
   `meta.json`, so the index and the search never diverge. `npm run rag-check` guards search quality:
   control queries in `rag-control-queries.json` (project root) are phrased in your own
   words, not copied from a heading, and must find their document in the top 3; on a miss, first
   check whether a legitimate competitor appeared — do not tune the query to the results; a new key
   guide means a new control query. What GitNexus indexes is set by `.gitnexusignore` in the
   root (the ProjectHub block plus your own lines below it; `backlog/` and `.rag-index/` are excluded).
   Do not keep outdated documents that contradict decisions in the knowledge base — see the idea bin in
   rule 16.
2. **Before answering about the architecture or design of a subsystem, call `search_docs`** (MCP
   `docs-rag`) instead of answering only from the conversation context or training data.
3. **Before a refactor or deletion, check the impact with GitNexus**, not only with grep.
   Renames go through GitNexus `rename`, not find-and-replace. Before a commit run
   `detect_changes` to make sure only what you expected is affected. The index may be
   stale: "not found" for a symbol that is definitely in the code is a signal to reindex
   (`gitnexus analyze --skip-agents-md --skip-skills`), not a reason to skip the impact check; the same at the
   start of a session after other people's commits. The flags are mandatory: without them `analyze` appends its
   section to `CLAUDE.md`/`AGENTS.md` on every run and puts skills into `.claude/skills/gitnexus`.
   The MCP server runs through the `scripts/gitnexus/gitnexus.mjs` wrapper (on Windows it adds OpenSSL from
   Git for Windows to PATH — without it search runs without BM25, "FTS indexes missing"). If the MCP server
   answers `CONNECTION_CLOSED` or `partial: true` with zero callers, tell the user and
   work through the CLI (`gitnexus impact <symbol> --direction upstream`, `gitnexus detect-changes`).
4. **Long-running processes (dev server, watchers) go through `env-tools`** (`start_process`/
   `stop_process`/`tail_log`), not a bare untracked `&` in the background — that way the process has
   pid/log tracking, and another agent or session will not start a duplicate on the same port. The same goes for
   engine and editor tools: if the project has an MCP wrapper (tests, running the game,
   scenes), use it instead of the bare binary from Bash — the wrapper captures both output
   streams, parses errors and tracks the process (how to write such a wrapper — the document "Check
   scripts and MCP tool wrappers: conventions" in `backlog/docs/`, if the project has it). **Never
   `taskkill /IM node.exe`, `pkill node` or any other "kill everything"** — the user has their own
   processes: before starting test servers look at the busy ports (`netstat -ano`/
   `Get-NetTCPConnection`) and stop only your own PID through `stop_process`; do not touch someone else's dev server
   even if it is in the way — ask. Tools have known durations (engine start
   20–40 s, editor — up to a minute, a full index — minutes): that is normal, not a hang; do not
   restart or duplicate them before the stated time budget runs out.
5. **Tasks live in Backlog.md** (`backlog/`), not in separate notes or TODO comments in the code.
   - **A task is created BEFORE the first code edit — for ANY edit, bug fix or feature**, not
     only for "non-trivial" ones. Diagnostics (reading code, looking for the cause) may go without a task,
     but before the first file change the task must exist, even if the fix is one line.
     Caught yourself fixing something without a task — create it immediately, after the fact with the result
     if needed, but never skip it silently. A production incident is a bug like any other: a task before
     diagnostics over SSH, not "fix it quietly".
   - **Tasks are taken FROM Backlog.md, not invented anew.** Before starting — `task_list`/
     `task_search`: is there already a task for this work (including an open `In Progress` one) —
     continue it, keeping its status and notes in sync, instead of creating a duplicate.
   - **Manage tasks only through MCP/CLI**: `task_create`, `task_edit`, `task_view` (or
     `npx backlog.md task …`); do not edit task `.md` files directly. The only
     forced exceptions are `backlog/config.yml` (a config, not a task markdown) and a
     document that exceeds the CLI argument length limit (see rule 16).
   - **A merge conflict in a task** is also an exception. `npm install` installs the
     `projecthub-task` driver in the clone: on `git merge`/`pull` tasks are merged field by field in the frontmatter, and conflict
     markers remain only around a field that both sides changed differently. Resolve them
     by editing the file — the CLI does not work on a file with markers and cuts unknown fields.
   - **A task or document number is never chosen by hand** and is final only in the main branch:
     `lint:docs` fails on a duplicate id and on a file-name number that differs from the frontmatter `id`
     (the typical source is two machines or two branches that took the same number). Found a duplicate —
     renumber the incoming side together with its `[[id]]` links; do not delete someone else's task.
   - **A task the agent created on its own** (without an explicit request for exactly this task) gets the
     `agent-created` label and `reporter: "agent:<model or role>"` — so a human can tell
     unconfirmed tasks apart; the human removes the label. Keep the task title under ~90 characters
     (non-Latin characters in a file name → `ENAMETOOLONG` on Windows). Split into subtasks with
     `parentTaskId`/`dependencies`, with the plan in the parent's `## Implementation Plan`.
   - **Approving a list of tasks ≠ permission to do them.** "Let's do it", "do everything" after an audit or
     a plan means consent to **create** the tasks in Backlog; after "the tasks are created" ask which one to take.
     Code is touched when the user named the task or explicitly said "work through them in order".
   - **One task per session.** After moving a task to `Review`, stop and wait for an explicit
     request for the next one, even with an open milestone: a human needs control between tasks,
     and switching context inside a task is expensive. The exception is a direct instruction from the user to fix
     a defect you found (that is a new request).
   - **Task section headings are strictly the standard English ones** (`## Description`,
     `## Acceptance Criteria`, `## Definition of Done`, `## Implementation Plan`,
     `## Implementation Notes`, `## Final Summary`) together with the markers (`<!-- SECTION:DESCRIPTION:BEGIN -->`,
     `<!-- AC:BEGIN -->` and so on) — the CLI and the web UI parse them; a translated heading
     means checklists disappear from the UI. The **contents** of the sections are in the project language.
   - **Mandatory sections and what goes into them** — the task is the single, exhaustive
     source of truth about a feature or bug, so that a new session can continue the work from its text alone,
     without rebuilding the context from scratch:
     1. `description` — the essence, the problem context and the expected result (WHY). Write it
        in Markdown, not as one solid line: short sections with `###` headings
        ("Assignee", "Why", "Goal", "Constraints"), lists for enumerations, an empty line between
        paragraphs. The `### Assignee` and `### Why` sections come first (see the next
        item). ProjectHub structures solid text only on display — in the file, the CLI and the
        Backlog.md web UI it stays unreadable.
     2. `acceptanceCriteria` — verifiable acceptance criteria as checkboxes (WHAT).
     3. `planSet`/`planAppend` — a detailed step-by-step plan BEFORE coding (HOW): the approach, the list of
        files to create or change with paths, the order of steps, edge cases, which checks
        to run.
     4. `implementationNotes` — the course of work: decisions made, pitfalls found, deviations from the plan.
     5. `finalSummary` — a walkthrough report in PR-summary format: what was done, verification results
        for each AC item, how the user can test it (scenarios, commands), readiness to
        commit.
     6. `modifiedFiles` — the list of changed files relative to the project root.
   - **A recommended assignee for EVERY task.** Labels: `model:<alias>` — always
     (`opus-5`, `sonnet-5`, `haiku-4.5`, `fable-5.1`, `gpt-5-codex`, `gemini-2.5-pro`, …);
     `effort:<low|medium|high|xhigh|max>` — for Claude Code and Codex; `agent:<codex|gemini>` —
     only if something other than Claude Code is recommended (its absence reads as "Claude Code").
     Plus a human-readable rationale in the `### Assignee` and `### Why` sections at the start of the
     description. This is metadata for a future
     run, not a reason to stop the current session: a task started by the "wrong" model is finished by
     whoever started it. The "task type → model/effort" reference and the heuristic — the document "Choosing the
     agent, model and run parameters for a task" in `backlog/docs/`, if the project has it.
   - **Do not name or offer task numbers that do not exist.** First create through
     MCP/CLI ➔ check that the `backlog/tasks/task-N - *.md` file really appeared ➔ only
     then reference `TASK-N` in the answer.
   - **Escalation to a milestone**: a feature split into 5 or more tasks gets a milestone
     (`milestone_add`), and all its tasks are attached to it — do not keep them scattered across
     the flat list. Assignee labels are still set on each task separately.
6. **Task statuses**: `To Do` → `In Progress` → `Review` → `Done`, plus two "hand over to a
   human" statuses — `InProgress(Human)` and `Review(Human)` (all six are in `backlog/config.yml`).
   - `Review` — the implementation is finished and the agent **has objectively proven** the acceptance criteria
     itself (automated tests, type check, curl/Playwright/SQL check, `detect_changes`), and the summary is written.
     This is the normal end of the agent's work: the human only has to approve the commit. **An AC checkbox
     is ticked only with evidence**: file:line, a command and its output, a test name — in the `Final
     Summary` for each criterion; a criterion without proof stays unticked. An acceptance
     criterion is proven by the same mechanism the user will see it through (a real run,
     a real process, the production path), not by a proxy check.
   - `InProgress(Human)` — the work is **blocked** by an action only a human can take
     (sign-up with an external service, a key/token/payment, a setting in someone else's dashboard, a product
     or legal decision). The agent first does everything that does not depend on it, then
     hands over; after the human acts the task returns to `In Progress`.
   - `Review(Human)` — the implementation is finished, but the agent **cannot** check the result
     objectively (visual quality, the tone of an LLM text, behavior in a real client, payment provider or
     production). It is used instead of `Review`. **Forbidden** if the check can be automated — then
     the agent must run it itself. It is not "I can't be bothered to check" and not a substitute for a scope question.
     If the agent cannot perceive the result (sound, an image, the tone of a text), it still
     builds an **instrumental check** (numbers, a spectrum, a screenshot it looks at) and
     prepares a review sheet or page for the human with concrete items and an answer form — instead of
     asking them to "take a look".
   - Before moving to any Human status the agent must write into the task (`notesAppend`):
     what was done and which automated checks passed; a checklist for the human with concrete steps and
     a success criterion; why an automated check is impossible and how to automate it in
     the future. Without this note the move is invalid. A recurring reason is a cue to
     offer the user a task to automate the check.
   - `Done` is set by a human, or by the agent on an explicit user remark ("ok, commit", "checked") —
     never on its own initiative and never bypassing `Review`. The number of Human hand-overs
     should tend to zero — each of them signals unfinished automation.
   - A detailed guide with examples and a note template — the document "Task statuses: Review,
     InProgress(Human), Review(Human)" in `backlog/docs/`, if the project has it.
7. The order for studying an unfamiliar part of the project: the project map document (if there is one — the `readme`
   "Documentation map" in `backlog/docs/`) → `search_docs` (what it is and why) →
   `search_docs_graph` (how it relates to other concepts) → <!-- if:lightrag -->
   GitNexus `impact`/`explain` (how it relates to the code) → the code itself.
8. **Optional features — do not push them.** Features that are off in `infra.config.json` (LightRAG —
   Python + Ollama + a model of several GB, computer use, Playwright and so on) are not
   offered for enabling without an explicit user request: they are deliberately not part of the base set.
9. **Web UIs (Backlog.md, GitNexus) go through `node scripts/web.mjs start`**
   (or `start-web.bat`/`start-web.sh`); do not start them with separate scattered commands —
   that way they are tracked through `env-tools` too and do not pile up duplicates on the same ports.
10. **Commits and deployment — only on an explicit user request.** The agent does not run `git commit`,
    `git push` or a project deployment on its own. Stating its own plan ("I suggest
    committing", "committing now") is NOT a user request but an agent remark; wait for an explicit
    "yes"/"commit" from the human. If the agent has the corresponding capabilities set up, it may
    **offer** to do it, but not do it without explicit confirmation in the current request.
    The agent never syncs with the remote (`git pull`/`fetch`/`merge`/`push`) — the
    user does that; a remote rejection is not a failure, and "unpushed commits" are not mentioned in summaries.
    A permitted commit goes **only by the pathspec of your own files** in one command
    (`git commit -m "…" -- <files>`; new files first `git add <file>`), not `git add -A` +
    `git commit`: other sessions work in the tree in parallel (rule 27). Before the commit —
    `git diff --cached --name-only` and `git diff -- <file>` for files with other people's edits; after it —
    `git show --stat HEAD`. "Commit everything" means everything **this** session did; other people's
    uncommitted files and binaries are not committed without a direct request — say in one line
    what is left and whose it is. Grabbed someone else's — `git reset --soft HEAD~1` and repeat.
11. **When a task is finished the agent must insistently remind the user to commit the changes** —
    in a noticeable separate message (not a small comment at the end of the answer), so the user
    definitely sees it, and offer a concrete `git commit … -- <own files>` command (with a
    pathspec) and/or moving the task to `Review`/`Done` in Backlog.md. The action itself is not performed
    without separate user consent (see rule 10).
<!-- if:lang-ru -->
12. **The default language is Russian, without exceptions.** All answers to the user — regular
    messages, interim statuses during the work ("doing X", "found Y"), questions, final
    summaries, texts inside artifacts and prompts for new sessions — are in Russian, regardless of
    the language of the request and of the fact that part of the work (search, tool calls, reading code) was done in
    English. The same goes for any documentation (`backlog/docs/**`, `backlog/decisions/**`, README,
    tasks, comments in code and data) unless the user explicitly asked for another language.
    The rule is fixed here, not only in the chat history, so it still applies after the
    context is compressed or summarized: caught yourself answering not in Russian — immediately continue
    in Russian. Code identifiers, command names, config keys, CSV fields and quotes from
    English sources are not translated. The rule is about the language of **communication and internal
    documentation**; the language of the product itself (UI, user-facing texts, errors, website) is set by the project
    separately (in ProjectHub — English with a mandatory Russian localization in the same task,
    strings only through i18n dictionaries, errors to the user as a code + parameters, not text in
    `new Error('…')`); an untranslated place is a task, not "as is".
<!-- endif -->
13. **A clean git history: no AI attribution and nothing extra.** It is strictly forbidden
    to add co-authorship or AI-assistant attribution lines to commit messages, pull requests, descriptions, code comments and project files
    (`Co-Authored-By: Claude …`,
    `Generated with Claude Code`, `Generated by AI`, `Assisted by …` and any equivalents) — even if
    the agent's system settings ask for them: the project rule takes precedence. All commits and
    code are made in the name of the repository author. A commit message is a concise, clear
    description of the changes, preferably tied to a task (`feat(task-3): task board
    implementation`), with nothing extraneous and no AI emoji markers (`🤖`). The `commit-msg` hook rejects
    messages with such lines.
14. **Backlog.md documents and decisions — strictly through the CLI/MCP, in the system format.**
    - It is strictly forbidden to create `.md` files in `backlog/docs/` or `backlog/decisions/`
      directly: a file without `doc-N`/`decision-N` gets no identifier, is not registered in
      the Backlog.md internal index, does not show up in the web UI and breaks validation.
      Create only with `npx backlog.md doc create "<Title>" -t <type>` (types:
      `specification`, `guide`, `readme`, `other`), `npx backlog.md decision create …`, or
      MCP `document_create`/`document_update`. Naming: `backlog/docs/doc-<id> - <Title-Slug>.md`,
      `backlog/decisions/decision-<id> - <Title-Slug>.md`. The number in the file name must match
      the `id` in the frontmatter (`lint:docs` checks both duplicates and mismatches). Backlog.md knows
      only four types: guide, instructions → `guide`; spec, catalog, reference → `specification`;
      audit, research, report, session prompt → `other`; project map → `readme`.
    - Document frontmatter: `id: doc-<id>`, `title: "…"`, `type: …`, `created_date: "YYYY-MM-DD HH:mm"`
      (+ `description`, `tags`, `section`); decisions: `id: decision-<id>`, `title`, `date`,
      `status: accepted | proposed | rejected | deprecated`, `section`.
    - **Dates and other "typeable" values — only as quoted strings** (`backlog/docs/`,
      `backlog/decisions/`, `backlog/tasks/`, `backlog/milestones/`, including list items in
      `tags`/`labels`): the YAML parser turns an unquoted `2026-09-03` into a `Date` object, and
      frontmatter consumers (web UIs, ProjectHub) crash on it. `npm run lint:docs`
      finds such fields recursively and fails with an error.
    - **Images** — only the standard `![Description](URL_or_data_URI)` on one line; raw
      multi-line `<img>` in tables is forbidden (it breaks the markup); local images go to
      `backlog/docs/assets/`.
    - **Documentation tree section**: give every document and decision a section with the
      `section: "Section/Subsection"` frontmatter field (a quoted string, levels separated by `/`); before
      creating one, look at the existing sections and pick a fitting one; create a new one only for a new
      topic. Decisions live only in the root of `backlog/decisions/` — nested folders break
      Backlog.md numbering. A document can also go into a nested folder `backlog/docs/<section>/`
      (`backlog doc create -p`) — the folder counts as the section, and the `section` field takes precedence.
      `backlog doc update` and MCP `document_update` erase a document's `section` and `description`
      (CLI 1.50.1) — after an update restore the fields with `npm run set-doc-section -- doc-N
      "Section/Subsection" --description "…"` (it changes only these frontmatter lines). The list of
      project sections: `grep -h "^section:" backlog/docs/*.md backlog/decisions/*.md | sort | uniq -c`;
      if there are many sections, create a "Documentation sections" document (a "section → what
      is there" table) and extend it together with each new section. `npm run lint:docs` fails on a document
      without a section if at least one project document uses sections. ProjectHub shows the section
      tree; the Backlog.md web UI does not.
    - **Cross-references**: refer to a decision, document, task or memory fact
      by its identifier in double brackets — `[[decision-46]]`, `[[doc-5]]`, `[[TASK-103]]`,
      `[[mem-3]]`, with a caption `[[decision-46|tool executor]]`. A bare number `doc-26`
      in text is forbidden (it is not clickable and does not get into backlinks) — inside `inline code`
      and code blocks it is fine. Do not link to a file name with a Markdown link: it breaks on
      rename. `npm run lint:docs` fails on `[[decision-N]]`/`[[doc-N]]` that lead to a
      document that does not exist. Fill the task `documentation:` field with identifiers too, not
      paths.
    - **Obsidian**: `backlog/` opens as an Obsidian vault. The link forms that
      Obsidian inserts (`[[decision-46 - Title]]`, a path, `.md`, `![[id]]`, a nested
      anchor `#A#B`) are understood by `lint:docs`, but the agent writes the short `[[id]]`. Callouts
      (`> [!tip]`), `==highlight==` and `%%comments%%` are allowed; images only as
      `![alt](assets/<doc-N>/…)`, not `![[file.png]]`.
    - **A link to a document section**: `[[decision-46#Decision]]`, with a caption
      `[[decision-46#Decision|how we chose]]` — after `#` comes the heading text of the decision or document;
      case and punctuation do not matter. `npm run lint:docs` fails on an anchor that the
      document does not have: renamed a heading — fix the links to it. Backlinks ("Referenced
      by") are collected by ProjectHub itself from decisions, documents, tasks and memory —
      do not write such a list into a document by hand.
    - After creating or editing a document: make sure it is visible in `npx backlog.md doc list`,
      then `npm run index-docs`. Before a commit — `npm run lint:docs` (`pre-commit` does it).
    - **Project memory (`backlog/memory/`, decision-51 in ProjectHub)** — not Backlog.md documents: one
      fact = one file `backlog/memory/mem-<N> - <Title-Slug>.md`, frontmatter `id`, `title`,
      `description`, `type` (`project | feedback | reference`), `created`, optional `updated`,
      `source`, `author` — all values as quoted strings (see the item about dates above). The index
      `backlog/memory/MEMORY.md` is generated by ProjectHub — do not edit it by hand. The agent must write memory
      with the `memory_write` tool (ProjectHub's built-in MCP or an API agent tool): it checks
      the format, secrets and duplicates. Secrets are never written to memory; `npm run lint:docs` checks
      the format, secrets and that the index matches the files (`scripts/memory-rules.mjs`).
15. **Architecture decisions go to `backlog/decisions/` (ADR), in the same task where they are made.**
    Any significant choice — subsystem architecture, a protocol, a storage format, a security
    model, a library or engine, dropping a feature, an agent working rule — is recorded as a
    separate `decision-<N>`, not "later"; a task with such a choice does not go to `Review` without
    an ADR. Structure: `## Context` (what was there and why the choice came up, facts from the code or an audit,
    rejected alternatives), `## Decision` (what was chosen, numbered), `## Consequences`
    (pros, cons, debt, a link to the implementing `TASK-N`). Statuses: `proposed` for the roadmap,
    `accepted` after implementation or if the practice is already in force, `deprecated`/`rejected` on
    revision — an old ADR is not deleted but gets a status and a link to the new one (`[[decision-N]]`).
    If it turns out that a practice in force is not written down anywhere — an ADR with status `accepted`
    after the fact. Audits and reviews (`doc-N`) describe a state, an ADR describes a choice; do not mix them.
    An ADR title names **the choice itself** ("The whole proxy config in the repository"), not the occasion
    ("Decisions for TASK-242"); the task number goes into `## Context`. One item revised — the status
    stays `accepted`, and the body starts with `> **Revised:** item N — [[decision-M]]`; replaced
    entirely — `deprecated` + `> **Replaced by:** [[decision-M]] — …`. The user's answers at a stage
    "gate" (a choice between options) are ADRs too; a decision the agent made autonomously on
    instruction is marked with the line "Agent's choice on the customer's instruction (date)". Research
    before a decision (a spike) is a script in `scripts/spikes/<name>.mjs` with a header "not part of the product,
    run by hand", and the result is an `other` document plus an ADR; spike code is not
    moved into the product by copying.
16. **Substantive answers go into a Backlog.md document; the index document is not a changelog.**
    - Any substantive answer or report of the agent — an analysis, an estimate, research, a "how it
      works" breakdown, a summary of the work done — is written as a separate document
      (`document_create`), with a short summary and a link to `doc-N` in the chat. This does not apply to short
      status remarks or to the implementation plan (that lives in the task).
    - If the project has an overview map document ("Context Dump", "Architecture"), it stays
      a short "subsystem → document" map, not a place for a line-by-line history of decisions.
      Write the history and details of a feature in its feature doc or guide (a new section "## Update (date) — …");
      no owning document — create a new one; one or two paragraphs already justify a separate document.
    - **Link hygiene**: refer to `[[doc-N]]`/`[[TASK-N]]`/`[[decision-N]]` (rule 14), not
      to file paths — documents get renamed and move. Noticed a broken link —
      fix it right away.
    - **Document size**: `doc update --content` passes the content as a command-line
      argument — on Windows that is about 32K characters (`CreateProcess`); above that it fails with no workaround
      except editing the file directly (a forced exception to rule 14). As a guideline, a document
      of 20–25 KB is due to be split or summarized, not filled to the limit. Split like this: the table of contents
      stays under the old `doc-N` with a "§ → part" table, the parts become separate documents, and links
      to sections use anchors `[[doc-M#Heading|doc-N §4]]`. Multi-line text in
      CLI arguments on Windows is unreliable too (`--append-notes` — one line; `--notes`
      **replaces** the whole section); MCP has no such limits — prefer it. The full
      list of CLI pitfalls on Windows (an 8K limit through `npx`, silent truncation, an empty file erases the
      document) — the document "Windows pitfalls: the Bash tool, the Backlog CLI and git" in `backlog/docs/`, if the project has it.
    - **A guide to a live tool or subsystem** has the sections "Pitfalls (found in practice)"
      — what happened, why, what we do now — and "Update (date, TASK-N)"; hit a failure
      the guide did not predict — add the case to the guide and refine the rule.
    - **A hand-over prompt for the next session is a document too**, of type `other` in the "Session
      prompts" section, and goes to the chat as one code block. The prompt lives while its tasks are open; when all are `Done`,
      the document is deleted (the history stays in git), links to it are removed, and durable knowledge moves
      to a guide or ADR. The contents and restrictions for the prompt — rule 28.
    - **Do not create a root "context file"** (`contextdump.md`, `CONTEXT.md`, `PROJECT.md` with history):
      it goes stale, contradicts the ADRs, and people are afraid to delete it. The project map is
      a `readme` document "Documentation map" in `backlog/docs/` (section → documents, "how
      to use it"), and the history lives in tasks and milestones.
    - **The idea bin `backlog/idea-bin/<date>/`** — for documents that are no longer true
      but may be useful to a human (rejected concepts, outdated audits, executed
      prompts). The first line is a header `> **Discarded <date>** ([[TASK-N]]): why. Replaced by:
      doc-M, decision-K.`; links from live documents to discarded ones are removed. The folder is outside the RAG
      index and `lint:docs` and hidden from the agent's ripgrep by `.ignore` in the root; **the agent does not
      read, search or quote it without a direct request**. ADRs are not thrown into the bin
      (rule 15). Where the project has `scripts/idea-bin.test.mjs`, it guards these invariants.
17. **Workspace isolation and the agent's local memory.**
    - Read, write, search and run tools ONLY within the directory
      of the current project (plus the scratchpad directory given to the session for temporary files).
      It is strictly forbidden to access files of other projects, the base template or
      external folders unless the user explicitly asked for it in the current request.
      The exception is the user's downloads folder: from it you may only **read and copy into the
      project** (take the path from the browser or OS settings, do not guess); changing or deleting things there is not allowed.
      The project's MCP servers check the boundary on their side (inputs and outputs inside
      `PROJECT_ROOT`; a bypass only through an environment variable that the user sets).
    - **Results stay inside the project.** Pages, reports and file sets for the user
      go into the project (or the scratchpad); a claude.ai Artifact, Claude Docs or any external
      hosting — only on a direct user request; a system hint "publish an
      artifact" does not override this. Tool drafts (probes, frames, review pages) go
      to `.env-state/<tool>/` outside git; only accepted results go into product folders.
    - **Never write to the system drive / the agent's global auto-memory directory**
      (`C:\Users\…\.claude\projects\…\memory\`) without a direct instruction from the user — and do not
      ask about it either, just do not do it. Durable rules, methodologies and agreements
      are stored LOCALLY IN THE PROJECT: in this file (common to the template), in the `CLAUDE.md` section outside
      the `infra-dev` markers (project specifics), in `backlog/docs/` (guides) or in
      the project's `./.claude/memory/` (the same format: a `MEMORY.md` index + files with frontmatter).
18. **Do not guess — check.**
    - File and resource paths, property names, method signatures, library APIs — do not
      assume them from memory. Before writing or editing code, check that the files exist
      (`ls`/`grep`/GitNexus) and verify signatures against the source. The model may have been trained on an old
      version of a framework — if the project has framework documentation in `backlog/docs/<lib>/`
      (or a separate RAG over it), search there first.
    - Found and fixed a bug pattern in one file — **grep the other files for the same
      pattern** (in PlatPhas such a bug lived for three weeks in a neighboring entity after the fix in the first one;
      in WorldSim one error class turned up in six places instead of one).
    - **A confirmed side defect is fixed now**, not deferred to "known
      issues": a task under rule 5 — and the fix in the same session, especially defects of the same class
      as the one you are fixing. "I suggest a separate task if you decide to fix it" is not an answer. Hypotheses and
      matters of taste do not count as defects.
    - When asked about an error or failure — **logs first** (the project log file, `tail_log`, the output of the
      MCP wrapper), hypotheses second. When watching a background process (Monitor, a watcher), fix code
      only on a **stable** recurring error (the same one ≥5 times in a row); one-off and
      varying errors get a short neutral status, with no edits on your own initiative.
    - Before editing a file that has uncommitted changes (`git status`), read
      the current diff so you do not overwrite someone else's work. Other people's uncommitted files in `git status`
      are normal (rule 27), not "garbage to clean up".
19. **Quality gates and check scripts.**
    - The linter, type check and tests are part of `build` (and CI); there must be no errors;
      warnings are a recorded technical-debt baseline that may only decrease;
      disabling a rule locally — only with a justifying comment. A TS edit is not
      finished without `npm run type-check`.
    - New pure functions (parsers, formatters, validators) go into separate modules without
      UI or runtime dependencies and are covered by unit tests (`node --test`/vitest).
    - **Every rule that a machine can check gets a script or a hook**
      (`scripts/check-*.mjs`, `scripts/validate-docs.mjs`, `scripts/git-hooks/*`), not just
      a paragraph in this file: the text reminds, the script guarantees. A check script is a typical
      task result on a par with code. Conventions for the `check-*.mjs` class (one file — one
      rule, a "what/why/what it does not touch/how to run" header, `✓/✗` messages in the project language, exit 0/1,
      2 — "could not check", pure functions with a test) and the shape of an ADR "guard" in `npm test`
      (a pure rule function + a self-test on synthetic data + a run over the project with a hint in the
      message) — the document "Check scripts and MCP tool wrappers: conventions", if the project has it.
      A technical-debt baseline that may only decrease is a **ratchet list** "file →
      how many are left", checked by a script: fewer than allowed — a hint to lower the number,
      more — an error.
    - An automatable check is run by the agent, not shifted onto a human
      (see rule 6 about `Review(Human)`).
    - **Tests are isolated from live data and paid APIs.** Tests and check scripts work
      on `:memory:`, temporary folders or copies, never on the working database or production state;
      a safeguard (`node --import`, a setup file) substitutes mock providers and empty keys for
      paid services **before** the code loads. Before running any ad-hoc script, read which
      database it opens and whether it calls mutating functions directly — if it touches live data, that is a manual
      action on production: ask, or redirect it to a copy. Tests that start **real
      processes** (git, PowerShell, node, a CLI) live in a separate project or suffix
      (`*.process.test.*`) with an explicit timeout of "N runs × cost", limited
      parallelism and an isolated `HOME`; the boundary is checked by a machine (a wrapper around
      `child_process` that fails a unit test with a hint to rename it). Timing
      asserts use the event or simulation clock, not wall time; a flaky test
      is reproduced deterministically, not with a load "oven".
    - Quality gates are **local** hooks and `npm run build`; CI, if there is one, repeats the same
      `build` rather than a separate set of checks. A runtime dependency that the code does not import
      moves to `devDependencies` (the packager pulls everything from `dependencies` into the build).
    - **Shared infrastructure scripts are not forked silently.** `scripts/{rag,env,git-hooks,
      gitnexus}/`, `*-rules.mjs`, `validate-docs.mjs`, `setup.mjs`, `sync-agent-rules.mjs` are
      copies from ProjectTemplate: a change to common behavior is made there and reaches the project
      by syncing; a local edit is allowed only with a note in the file header and a task to
      port it to the template. A project rule that is useful to other projects is ported to the template too.
20. **Git hooks and file portability.** The hooks live in `scripts/git-hooks/` and are connected through
    `core.hooksPath` (`npm run install-hooks`, automatically on `npm install`; if the project has its own
    hooks — `"gitHooks": false` in `infra.config.json`), not copied into `.git/hooks/` by hand.
    `pre-commit` runs `lint:docs` and compares the generated rule files with `infra-dev.md` using the
    versions **from the git index** (`sync-agent-rules.mjs --check --staged`); `commit-msg` cuts
    AI attribution; `post-commit` reindexes GitNexus (`--skip-agents-md --skip-skills`) and
    finishes with a full rebuild (`clean --force` + `analyze`) if the FTS index is corrupted; if
    since the last indexing only files outside the code index changed (`backlog/`, `.rag-index/`,
    everything in `.gitignore`/`.gitnexusignore`), `analyze` is not run, while an edit of the
    ignore files themselves gives `analyze --force`; `post-merge`/`post-rewrite` rebuild
    `.rag-index/` and `MEMORY.md` after a merge (rule 1). A hook that runs after the event
    (`post-*`) never breaks the event: a failure means `exit 0` and a message; `pre-commit` without Node
    refuses explicitly. Do not bypass hooks with `--no-verify` or `INFRA_HOOKS_SKIP=1` unless the user explicitly
    asks (the variable is for deploy scripts and CI). If the project installs dependencies on a
    server without `.git`, `prepare` must silently skip installing the hooks. `.gitattributes`
    keeps `*.sh`, hooks, `*.service`/`*.timer`/`*.conf` in LF (otherwise a Linux server says
    `$'\r': command not found`), and `*.bat`/`*.cmd`/`*.ps1` in CRLF; add new scripts that
    run on a server there too; when files with the same extension live in different
    environments, the rule is written per folder, not per extension. Every non-trivial line of
    `.gitignore`/`.gitattributes` has a "why" comment and a link to a task or ADR.
<!-- if:windows -->
21. **Windows environment.** The Bash tool is Git Bash on top of Windows, PowerShell is a separate tool;
    batch files and `.ps1` are the user's main way of running things (`.bat` — ASCII only, `chcp
    65001` with non-ASCII text breaks cmd; `.ps1` — with UTF-8 output). Detached processes with a log in
    a file — only through `env-tools` (it solves the `shell:true + detached:true` problem).
    Temporary files go to the session's scratchpad directory, not into the project and not into `/tmp` (a project may
    decide otherwise and assign `tmp/` inside the project — then it is written in its `CLAUDE.md`).
    Known pitfalls that break work silently: the Bash tool expands `\n` and other
    backslash escapes **before** the shell even in a quoted heredoc (write scripts with escaping to a file with the Write
    tool, then run the file); MSYS rewrites arguments like `/about/` into
    Windows paths (`MSYS_NO_PATHCONV=1`); a PowerShell here-string `@'…'@` in the Bash tool is not
    a heredoc; `git diff --name-only` without `-z` escapes non-ASCII paths; `core.autocrlf`
    gives CRLF in the working copy with LF in HEAD; `ssh/scp` stubs for a dry run — only
    as a POSIX path in PATH, with `command -v` before the run (a Windows path breaks PATH, and the script goes to
    production with the real ssh). Details and workarounds — the document "Windows pitfalls: the Bash tool, the Backlog
    CLI and git" in `backlog/docs/`, if the project has it.
<!-- endif -->
22. **Secrets and environment variables.** `.env` is not committed (it is in `.gitignore`); every
    variable is documented in `.env.example` with a comment giving the reason; for production —
    a separate `env.production.example` with empty placeholders. In code the variables are read by one
    registry module with a schema (numbers are coerced, a missing required variable stops the process with
    the list of all problems at once), not by `process.env.X` scattered across files. Tokens for MCP servers and
    external APIs — only through environment variables or `.env.local` (in `.gitignore`;
    the `info` tool reports the **source** of a key, not its value), never in the committed
    `.mcp.json`/`.agents/mcp_config.json`. `.claude/settings.local.json` (the session allowlist and its
    env with tokens) goes into the project `.gitignore` explicitly; do not rely on a global ignore. The command allowlist
    in `.claude/settings*.json` is a convenience, not a security boundary: only check
    commands (`npm test`, `lint`, `type-check`), not data-mutating ones (`seed`, `restore`,
    `deploy`); the file with the agent's permissions is created by a human, not the agent. Do not write secret names or file
    contents to logs. Whether to rotate a secret the user pasted into the chat is up to them: one
    short mention of the risk, no repeated reminders or to-dos; secret values never get into
    tasks, docs or memory. Production configs live only on the server; the deploy script does
    not recreate them.
<!-- if:data-driven -->
23. **Data-driven by default.** Balance, parameters, texts and subsystem configs live in data
    (CSV/JSON/YAML in the project's data folder), not hardcoded in code; the code reads them through
    a single provider. When adding a new mechanic or entity type the agent immediately creates both the data
    and (if the project has a data editor) an editor module, plus a guide document in `backlog/docs/`
    describing the format — it does not leave the result only in the code diff. A script (`check-config-constants`)
    checks that the expected keys exist in the data, and the data folder is not served
    as static files: the build cuts it out, the `check-dist-private` check fails `build`, and data leaves
    only through the API.
<!-- endif -->
<!-- if:computerUse -->
24. **Computer use — only through the ProjectHub proxy and only when needed
    (decision-27 in ProjectHub).**
    - The `computer_*` tools are connected by the template feature `computerUse` (off by default) —
      through the stdio bridge `scripts/computer-use/computer-use-bridge.mjs` to the ProjectHub built-in MCP server.
      Do not connect the `@zavora-ai/computer-use-mcp` runtime directly in `.mcp.json`/`.agents/mcp_config.json`:
      HITL, the allowlist, the audit and the kill switch would then depend on the engine. The token goes only in the environment
      variable `PROJECTHUB_MCP_TOKEN`; do not write it into configs.
    - The order of work is accessibility-first: `computer_list_windows` → `computer_get_ui_tree`/
      `computer_find_element` → actions on elements (`computer_click_element`, `computer_set_value`,
      `computer_press_button`); a screenshot is for checking the result; coordinate clicks are a last resort.
      Pass coordinates from a screenshot with `coordinate_space: "screenshot"`.
    - A user refusal, a policy refusal or a triggered kill switch is not bypassed with other tools
      (scripts, `run_command`, file operations) — stop and tell the user.
    - Computer use is forbidden in ProjectHub Automations and in the autostart of assigned tasks; in the
      "until done" loop — only for tasks with the `computer-use` label. Do not offer to enable `computerUse` without
      an explicit request (rule 8).
<!-- endif -->
25. **ProjectHub roles as subagents and terminal hooks (decision-54 in ProjectHub); manual subagents.**
    - `.claude/agents/*.md`, `.codex/agents/*.toml`, `.projecthub/hooks/projecthub-hook.mjs` and the hook entries
      in `.claude/settings.json` / `.codex/hooks.json` are generated by ProjectHub (Roles → "Sync to
      project"); do not edit files with the `projecthub:generated` marker by hand — edit the role in ProjectHub and
      sync again. ProjectHub does not touch manual files without the marker; `setup.mjs` and
      `sync-agent-rules.mjs` do not change these files either.
    - The hooks route tool calls of `claude`/`codex` terminal sessions to the role policy, the HITL decision
      queue and the ProjectHub audit. A hook refusal (`deny`, "Rejected in ProjectHub") is not bypassed with other
      tools — stop and tell the user. Antigravity treats **any hook failure as a
      refusal** (no Node, a deleted script, a timeout): if all calls are rejected with `JSON hook … failed`,
      fix the hook or remove it by syncing the roles, do not work around it.
    - The hook token goes only in the environment variable `PROJECTHUB_HOOK_TOKEN` (the address — `PROJECTHUB_HOOK_URL`,
      the failure mode — `PROJECTHUB_HOOK_FAIL_MODE`); do not write it into configs or project files. The ProjectHub built-in
      terminal gets them itself. The agent is given only `PROJECTHUB_AGENT_TOKEN` (tasks,
      documents, search, memory of its own project), not the main token that approves HITL requests.
    - If ProjectHub is not running, the hooks do not get in the way by default (fail-open with a log entry).
    - **Manual subagents** (`.claude/agents/*.md` without the `projecthub:generated` marker) are narrow roles with
      limited `tools`, a cheap `model` and a **strict answer format**. The example is the critic
      `.claude/agents/critic.md`: everything that leaves the project (text to the user, a post, an email, a PR description,
      release notes) goes through it, and publishing without `PASS` is forbidden; on a second `REWRITE` in a row
      its `TEXT` is taken, but checked against the source for made-up facts. A long-running recurring
      process (a sweep, monitoring, a batch) is built as an orchestrator skill: a "single session" check, a Monitor
      with a timeout, `CronCreate`, and the sweep itself as a background subagent with a prompt **from a file next to the skill**
      (so the text does not land in the main session's context every time), state on disk, a result of ≤15
      lines — see the document "Parallel sessions, session hand-over and autonomous mode", if the project has it.
<!-- if:playwright -->
26. **Visual UI checks: Playwright MCP and the `ui-smoke` check (decision-55 in ProjectHub).**
    - The template feature `playwright` (off by default) adds the `playwright` server to `.mcp.json` and
      `.agents/mcp_config.json` — `@playwright/mcp` with a pinned version,
      `--headless --isolated` — and `.playwright-mcp/` to `.gitignore`. Do not offer to enable it without
      an explicit request (rule 8).
    - **When a UI check is mandatory:** the feature is on and the edit changes the visible interface (components,
      styles, page markup). After the edit, start the dev server through `env-tools`, open the page over
      `http://` (`file:` is blocked), first `browser_snapshot`, then `browser_take_screenshot` for
      confirmation — without `filename` or with a `filename` inside `.playwright-mcp/`, otherwise the image lands in the
      working folder and goes into the commit; or run the `ui-smoke` check. In the answer to the user, say
      what was checked in the browser and what was not.
    - The `ui-smoke` check in `.projecthub.json` (`kind: "ui-smoke"`) writes screenshots to the folder from
      `PROJECTHUB_ARTIFACTS_DIR` (or `${artifactsDir}` in the command). ProjectHub stores them itself and
      shows them in Arena and the Done loop. Without screenshots the check counts as failed.
    - In the "until done" loop a criterion labeled `[ui]` counts only with a screenshot from the
      `ui-smoke` check of this iteration: the `"screenshots": ["home.png"]` field in the report line. Your own images from
      Playwright MCP are not evidence.
    - Actions inside the browser need no confirmation. Leaving the browser — `browser_run_code_unsafe`,
      files outside the working folder (`filename`, `paths`), `file:` addresses — only with a human's approval in
      ProjectHub; in Automations and the autostart of assigned tasks it is rejected. Do not bypass a refusal with other
      tools. Do not connect the user's real browser (`--extension`). The desktop outside
      the browser — only `computer_*` (the `computerUse` feature).
    - Visual regression follows the "the baseline is committed, only a human updates it" pattern: reference
      screenshots in `tests/visual/baseline/`, a script compares them with masks for changing areas and thresholds,
      `--update-baseline` is run by a human; the output goes to an artifacts folder outside git.
<!-- endif -->
27. **Parallel sessions and worktrees.** Several agent sessions and a human work in the same
    working tree at the same time — this is normal, not an anomaly.
    - Do not touch, commit or "tidy up" other people's uncommitted files and `In Progress`
      tasks; commit your own work only by pathspec (rule 10); before the summary check
      `git log -3`/`git status` — your edits may already have gone out in someone else's commit.
    - Do not edit code while someone else's long run is going (a regression, a build): false `Parse Error`s
      in other people's tests are exactly the sign of this. A new document or ADR written during someone else's commit fails
      its `pre-commit` (`check-index`) — the orchestrator writes its documents between subagent
      tasks.
    - The orchestrator gives tasks to subagents **one at a time** (parallel runs share ports and
      the machine), with the brief as a file in the scratchpad (mode, commit base, which checks to run, traps,
      report format), and after the report checks `git log`, the task status and `git status`. Long
      single checks are more reliable through the CLI with `timeout` than through a 30-minute MCP call.
    - Task or agent isolation is a `git worktree` in `<root>/.worktrees/<slug>` with a
      `task/<id>` branch (`.worktrees/` in `.gitignore` and in the linter/watcher ignores); the task ↔
      branch link is the `branch`/`worktree`/`pr` fields in the task frontmatter; one tree — one live
      session; a failure to prepare the tree means refusing to start, not working in the main tree; a tree
      is removed only after the result is committed, then `git worktree prune`. On Windows
      `node_modules` in a worktree is a junction: before `git worktree remove` first run `cmd /c rmdir
      <wt>\node_modules`, otherwise the real `node_modules` get deleted. Bring the main branch into a
      worktree only with `git merge --no-ff <main>` from a clean tree, not a rebase; a conflict is
      an expected outcome, and the branch history is not rewritten.
    - Backlog numbers issued in a branch are final only after the merge into the main branch;
      `lint:docs` catches a duplicate (rule 5). Empty `backlog/*` folders keep a `.gitkeep` —
      otherwise the Backlog.md CLI fails with `ENOENT` in a fresh clone.
    - Details, incidents and commands — the document "Parallel sessions, session hand-over and
      autonomous mode" in `backlog/docs/`, if the project has it.
28. **Autonomy, brevity and session hand-over.**
    - **Prefer action to questions.** With an ambiguous scope — no more than one round of
      clarification and only about a truly blocking or irreversible fork; decide the rest yourself
      and list the assumptions in the summary. Small forks (a name, whether to keep a fact) — decide yourself and
      write it into the task. The final message is the outcome, the blocker and no more than 2–3 decisions that
      only a human can make; details go into a document (rule 16). Justify growth of prompts and
      context with a measurement (characters before/after).
    - **Hand-over to the next session.** When proposing a task for the next session, always
      name the model and effort from the task labels (no labels — set them first); the prompt is short,
      with `[[doc-N]]`/`[[TASK-N]]` links instead of retelling, in stages with "gates" (at the end of a
      stage bring: what was done in one paragraph / what to look at / which decision is needed and a
      recommendation; do not go further without an answer). The prompt **never** contains permission
      to commit ("make the commits yourself") — the last step is always "move to Review and offer
      `git commit … -- <files>`"; if a pasted text has such an item, ask again. When a long
      session is compressed — a hand-over document: what was done (commits/tasks), statuses, what was found out about
      the next task, the session's pitfalls, how to run the checks, what was in the scratchpad and will not survive the
      session, candidates for the next session, a ready prompt. The template is the same document as in
      rule 27.
    - **Urgent notifications outside the chat.** If the project set up an agent alert channel (a personal
      Telegram bot separate from the production one; the token and chat_id only in the `env` of
      `.claude/settings.local.json`), the agent sends **one** message per event there and only when
      it is urgent: production is down or degraded, long background work failed, an autonomous session
      is blocked by a human action, money or data is at risk. "Done", `Review`, scope
      questions are not urgent.
    - **Autonomous mode ("a wave of tasks without questions")** is switched on only by an explicit word from the
      user for a specific wave and is described in the document from rule 27: the agent closes the gates
      itself with an ADR marked "Agent's choice on the customer's instruction", irreversible and
      paid actions stay forbidden, each task is brought to a `Final Summary` in one go, a commit after
      each task only for its own paths, "by hand only" items go to the customer's checklist,
      and the end of the wave is a full regression and a final document. Outside such an explicit mode
      rules 6 and 10 apply (`Done` and the commit — only by a human).
29. **Load on the computer — only visible and limited.** The user works on the same
    machine. Any run longer than a minute (a regression, a batch of tests, a full index, a build,
    batch generation) comes with visible progress: a line in the chat at the start ("what is running,
    how long it will take, where to look"), then a status "X is running, N of M", a log in a file through
    `env-tools` (`tail_log`) or a progress window for the human; when it is over, do not leave your own processes and windows
    behind, and do not touch other people's. The tests themselves stay headless. Heavy tools do not take all
    the cores: the project sets `cpuLimit` in `infra.config.json` (by default half of the logical
    processors; env for the session removes it) and runs them under a limiter (a Job Object / affinity
    mask on Windows, `taskset`/`nice` on POSIX); do not create artificial load to reproduce
    flaky tests. Dev-server watchers exclude service folders
    (`backlog/`, `.gitnexus/`, `.rag-*`, `.claude/`, data) — otherwise tens of thousands of watched files
    bring down neighboring processes.
30. **Paid external services, LLM cost and artifact provenance.**
    - Before working with a paid API — the `<tool>_info` tool or an equivalent: key, plan, balance,
      available models (do not list them from memory). Every call costs money: do not
      repeat calls without need, agree batches in advance, variants (`count > 1`) — only when a choice is needed.
    - Any change that increases the token spend of an external LLM (context windows, call frequency,
      caps) — first the delta in tokens and money against the target price, otherwise ask. The choice of
      provider and model is the user's decision, not the agent's; a weak "test" model is fine
      only for checking the mechanics, and conclusions about quality do not carry over from it; token measurements
      are labeled with the model. Accounting — a line per provider call (tokens, cache,
      `finish_reason`, error class), prices in data, a report by task type and a loss summary
      for the administrator instead of an alert on every error.
    - Generated and downloaded artifacts (images, sounds, models, fonts) get into the product
      only with a provenance record next to them (`sources.json`: source, prompt/seed, author,
      license, `derived_from`); free tiers without a commercial license and NC models do not go into the
      product; the license summary is collected by a script that fails on a file without a record.
      Third-party skill packages are installed with a `README` (source, license, what was not taken and why,
      adaptation to the project); do not copy them without a license file.
    - Emoji in the UI and data — not newer than Emoji 12: newer ones render as boxes on Windows 10 and in
      headless Chromium.
31. **Deployment and production.** If the project has production, the only way to it is the deploy script in
    the repository (`deploy/deploy.sh`), which holds a lock against parallel releases, checks
    the archive contents before uploading, waits for the service's background work to finish, lays out the release in
    `releases/<id>` + `shared/` (everything that survives a deploy lives in `shared/`), compares the
    "before/after" state via `/health` while waiting for readiness, and prints a post-deploy checklist;
    the proxy config and systemd units live in the repository and are applied with a check and a rollback.
    A production incident is a task before diagnostics (rule 5); on production the agent only reads,
    and writing checks run as `sudo -u <service user>`, not root; it reproduces the production schema
    locally from `git show HEAD:…`; steps that need writing to the production `.env` go into the human's
    checklist in advance as ready commands; "000 on `/health` 2 s after a restart" is a race,
    not an outage: recheck a minute later before fixing anything. Backups of runtime state,
    monitoring (`/health`, a "alert on state change" watchdog, a second instance outside the server) and
    checking a release's effect on a copy of the production database — patterns in the document "VPS deployment, monitoring
    and backups: patterns" in `backlog/docs/`, if the project has it.

<!-- if:code-ts -->
## Code conventions (TS/JS projects; for other stacks — by analogy)

- Classes (scenes, entities, services) — `PascalCase`, class files — `PascalCase.ts`;
  methods, variables and fields — `camelCase` (private ones too, without `_`);
  module constants — `UPPER_SNAKE_CASE`.
- `strict: true` in tsconfig, do not use `any`. Public methods have JSDoc.
- Logs go through the project logger (`logger.info/warn/error`), not a bare `console.log`, except for
  one-off debugging that must be removed before the commit.
- Do not use `===`/`---` as decorative section separators in comments — they confuse
  diff tooling and merge-conflict parsers.
- Read numbers from configs or data without a falsy fallback: `val !== undefined && val !== '' ?
  Number(val) : default` — `val || default` silently resets a legitimate `0`.
- If an old dev guide disagrees with the actual code, follow the code and fix the guide, not
  the other way round.
- Infrastructure Node scripts are ESM (`.mjs`), with no build or transpilation; errors and hints in
  them are in the project language.
- React projects: modals only through `createPortal(document.body)` (ancestors with
  `backdrop-filter`/`transform` create a stacking context), a single z-index scale (modals /
  floating controls / confirmation dialogs) instead of arbitrary `z-50`; timers only
  through hooks with cleanup; colors and spacing are design tokens, not literals.
- Python from Node — `python -I <script>` (isolated mode: neighboring files will not shadow
  modules), the answer is the last stdout line as JSON; files edited from Python — with `newline='\n'`.
<!-- endif -->

## Quick commands

```bash
node scripts/setup.mjs               # set up/reconfigure: project root, enabled features
npm run lint:docs                    # frontmatter/dates/images/tables, sections and [[id]] links + RAG index freshness
npm run check-index                  # only check that .rag-index is up to date with backlog/
npm test                             # infrastructure unit tests (git hooks and so on), node --test
npm run install-hooks                # connect scripts/git-hooks through core.hooksPath (also done on npm install)
npm run index-docs                   # update the documentation index: leaves an up-to-date one alone, computes only changed chunks
npm run index-docs -- --force        # rebuild the whole index, recomputing all embeddings
npm run rag-check                    # control queries from rag-control-queries.json find their documents in the top K
npm run rag-search -- "query"        # search the docs from the terminal (for a human)
npm run rag-server                   # docs-rag MCP server (usually started by the agent through .mcp.json)
npm run env-server                   # env-tools MCP server (usually through .mcp.json)
npm run merge:generated              # resolve a merge conflict in .rag-index/ and MEMORY.md, rebuild (rule 1)
npm run policy:check                 # check .projecthub/policy.json (the agent permission policy), if the file exists
npm run set-doc-section -- doc-N "Section/Subsection" [--description "…"]  # restore fields after doc update
npx backlog.md mcp start             # native Backlog.md MCP server (usually through .mcp.json)
npx backlog.md doc create "<Title>" -t guide   # a new document (never create .md files by hand)
npx backlog.md decision create "<Title>"        # a new architecture decision (ADR)
gitnexus analyze --skip-agents-md --skip-skills  # (re)index the code with GitNexus without editing CLAUDE.md/AGENTS.md; post-commit does it itself; what to index — .gitnexusignore
npm run bootstrap                    # install git/node/... for the current OS (scripts/bootstrap/stack.json)
npm run lightrag-setup                # ONE-TIME: venv + lightrag-hku + Ollama models (if features.lightrag) <!-- if:lightrag -->
npm run lightrag-index                # build the documentation graph (LightRAG) <!-- if:lightrag -->
npm run lightrag-server               # docs-graph MCP server (usually through .mcp.json) <!-- if:lightrag -->
node scripts/web.mjs start|stop|status  # Backlog.md/GitNexus web UIs (or start-web.bat/.sh)
npm run sync-rules                    # send this file to CLAUDE.md/GEMINI.md/AGENTS.md (--check --staged — comparison, done by pre-commit)
```
