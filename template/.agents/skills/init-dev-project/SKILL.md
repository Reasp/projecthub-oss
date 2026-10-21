---
name: init-dev-project
description: "Use when the user wants to bootstrap a new software project with the personal dev infrastructure (Backlog.md, GitNexus, committable vector RAG for docs, optional LightRAG doc-graph, env-tools MCP, shared agent rules) — scaffolds folder structure, surveys the tech stack, installs the environment cross-platform, and wires everything together. Works both when the infra becomes the project root and when it's added as a subfolder inside an existing project. Examples: \"init this project\", \"set up dev infra here\", \"bootstrap a new project with my usual tooling\""
---

# init-dev-project

> Дубликат `.claude/skills/init-dev-project/SKILL.md` для Google Antigravity (свой
> каталог скиллов — `.agents/skills/<имя>/SKILL.md`, отдельно от `.claude/skills/`).
> Источник истины по шагам — тот файл; при правке синхронизируй оба.

Разворачивает личную инфраструктуру разработки из шаблона `F:\ProjectTemplate` (источник
истины — `F:\ProjectTemplate\README.md`): Backlog.md, GitNexus, коммитимый векторный RAG
для документации, опциональный LightRAG-граф, MCP-инструменты работы с окружением,
кросс-платформенный bootstrap и общий файл правил для агентов.

> Этот скилл — последний шаг в цепочке (`RAG` → `MCP env-tools` → `bootstrap` → `init-dev-project`).
> Он не изобретает ничего нового, а копирует и связывает уже готовые куски из шаблона.
> Если `F:\ProjectTemplate` недоступен (другая машина) — спроси пользователя, где лежит
> актуальная копия шаблона, прежде чем продолжать.

## Шаг 0 — где мы и что уже есть

1. Определи целевую директорию — обычно текущая рабочая директория.
2. Проверь `F:\ProjectTemplate` — если пути нет, спроси пользователя, где искать шаблон.
3. Проверь, что уже есть в целевой директории: существующие `package.json`, `.git`, `backlog/`
   (включая `backlog/docs/`) — ничего не затирай молча, только дополняй/сливай.

## Шаг 1 — опрос

Задай пользователю напрямую (коротко, не превращай в анкету):

1. **Инфраструктура — это корень проекта, или подключается как подпапка** в уже существующий
   проект? Если подпапка — как она называется (например `dev-infra/`) и где относительно неё
   находится корень проекта. Это определяет `projectRoot` в `infra.config.json` (см. шаг 3).
2. **Основной язык/рантайм проекта** — Node.js/TypeScript, Python, Go, Rust, ещё не решено /
   только инфраструктура (без кода). Влияет только на `scripts/bootstrap/stack.json` — сама
   RAG/MCP-инфраструктура всегда на Node.js независимо от стека проекта.
3. **Имя проекта** для Backlog.md — по умолчанию имя папки корня проекта.
4. **Нужен ли LightRAG** (граф сущностей/связей документации)? **По умолчанию — нет.**
   Явно предупреди: это Python + локальная LLM через Ollama (несколько ГБ на диск, медленная
   индексация — минуты на документ, а не секунды). Включай, только если пользователь
   осознанно согласился, не предлагай как само собой разумеющееся дополнение.
5. **Нужен ли браузер для визуальной проверки UI** (Playwright MCP, фича `playwright`)? **По умолчанию — нет.**
   Спрашивай, только если у проекта есть веб-интерфейс. Фича ставит `@playwright/mcp` (headless, профиль в памяти,
   системный Chrome) в оба MCP-конфига и `.playwright-mcp/` в `.gitignore` (правило 26 `infra-dev.md`).
   Управление компьютером (фича `computerUse`) не предлагай — только по отдельной явной просьбе (правило 24).
6. Если в директории уже есть код — **проиндексировать его GitNexus сейчас же?** (да/нет).
   Для пустого проекта пропусти вопрос.

## Шаг 2 — git и Backlog.md

```bash
git init   # если .git ещё нет в корне проекта
npx --yes backlog.md init "<имя проекта>" --agent-instructions agents --defaults
```

Выполняется **в корне проекта** (не обязательно в текущей директории, если инфра — подпапка).
`--agent-instructions agents` пишет блок Backlog.md в **`AGENTS.md`** (не `AGENT.md` —
именно так называют общий файл правил и Backlog.md, и GitNexus). Если `.git` не создавали
(пользователь явно попросил без git) — добавь `--no-git`.

## Шаг 3 — скопировать инфраструктуру и настроить

Скопируй как есть в целевую директорию инфраструктуры (корень проекта, либо выбранная
подпапка — не путать с корнем проекта из шага 2):

| Из `F:\ProjectTemplate\...` | Куда |
|---|---|
| `infra-dev.md` | `./infra-dev.md` |
| `scripts/config.mjs`, `scripts/setup.mjs`, `scripts/sync-agent-rules.mjs`, `scripts/web.mjs`, `scripts/validate-docs.mjs`, `scripts/memory-rules.mjs`, `scripts/doc-rules.mjs`, `scripts/*.test.mjs` | `./scripts/` |
| `scripts/rag/*.mjs` | `./scripts/rag/` |
| `scripts/env/*.mjs` | `./scripts/env/` |
| `scripts/git-hooks/*` (pre-commit, commit-msg, post-commit, install.mjs, hooks.test.mjs) | `./scripts/git-hooks/` |
| `scripts/bootstrap/bootstrap.mjs`, `scripts/bootstrap/stack.json` | `./scripts/bootstrap/` |
| `scripts/lightrag/*` (только если LightRAG включён на шаге 1) | `./scripts/lightrag/` |
| `scripts/computer-use/computer-use-bridge.mjs` (только если пользователь явно попросил `computerUse`) | `./scripts/computer-use/` |
| `.gitattributes`, `.claude/settings.json` | `<корень проекта>/` (LF/CRLF по типам файлов; allowlist разрешений Claude Code) |
| `start-web.bat`, `start-web.sh` | `./` (рядом с package.json инфраструктуры) |

Гайды шаблона из `backlog/docs/` (`doc-1` развёртывание, `doc-2` RAG, `doc-3` статусы задач,
`doc-4` выбор исполнителя) **не копируются файлами** — номера `doc-N` в новом проекте
столкнутся. Нужные пересоздай в корне проекта после `backlog init` через
`npx backlog.md doc create "<Заголовок>" -t guide` (или MCP `document_create`) с содержимым из
шаблона. Вся документация проекта живёт внутри `backlog/docs/`/`backlog/decisions/`,
отдельной верхнеуровневой `docs/` в проекте быть не должно, и файлы документов создаются
только через CLI/MCP (правило 14 `infra-dev.md`).

В `backlog/config.yml` корня проекта добавь статусы передачи человеку (ключ `statuses`
не редактируется через `backlog config set`, правится прямо в файле):
`statuses: ["To Do", "In Progress", "InProgress(Human)", "Review", "Review(Human)", "Done"]`.

`package.json` — если в целевой директории уже есть, добавь в него `scripts`/`dependencies`
из `F:\ProjectTemplate\package.json` (не заменяя существующие одноимённые скрипты без
предупреждения; обязательны `prepare`, `install-hooks`, `test`, `lint:docs`, `check-index` и
зависимость `gray-matter`); если нет — скопируй как есть. `.gitignore` — добавь записи
оттуда же (node_modules/, .rag-cache/, .env-state/, .env*, dist/, scripts/lightrag/.venv/,
__pycache__/); **не добавляй** `.rag-index/` и `.lightrag-index/` в `.gitignore` — они должны
коммититься.

Затем настрой (это одна команда вместо ручной правки `infra.config.json`/`.mcp.json`):

```bash
node scripts/setup.mjs --project-root <путь-от-инфры-до-корня-проекта> \
  --features docsRag,envTools,backlogMcp,bootstrap,gitnexus[,lightrag][,playwright] --no-interactive
npm install
```

`--project-root` — `.`, если инфраструктура сама является корнем (обычный случай), или
относительный путь вверх (`..`, `../..`), если она подключена как подпапка. `--features`
перечисли явно по ответам шага 1 (`lightrag` и `playwright` — только если пользователь согласился; `computerUse`
не включай без отдельной явной просьбы).
`setup.mjs` сам запишет `infra.config.json`, синхронизирует `.mcp.json` (Claude Code) и
`.agents/mcp_config.json` (Google Antigravity) **в корне проекта** (не в подпапке с инфрой)
с правильными относительными путями до скриптов и подключит git-хуки через
`core.hooksPath` (то же делает `npm install` через `prepare`). Фича `gitnexus` требует
глобальный CLI: `npm i -g gitnexus` — если его нет, `setup.mjs` подскажет.

## Шаг 4 — окружение

```bash
node scripts/bootstrap/bootstrap.mjs
```

Если пользователь выбрал язык, для которого в `stack.json` шаблона нет записи (по умолчанию
там только `git` и `node` — они нужны самой инфраструктуре), добавь перед запуском в
`./scripts/bootstrap/stack.json` → `tools`:

| Язык | Запись для `stack.json` |
|---|---|
| Python | `{ "name": "python", "check": "python --version", "winget": "Python.Python.3.12", "brew": "python@3.12", "apt": "python3 python3-pip", "dnf": "python3", "pacman": "python" }` |
| Go | `{ "name": "go", "check": "go version", "winget": "GoLang.Go", "brew": "go", "apt": "golang-go", "dnf": "golang", "pacman": "go" }` |
| Rust | `{ "name": "rust", "check": "rustc --version", "winget": "Rustlang.Rustup", "brew": "rust", "apt": "rustc cargo", "dnf": "rust cargo", "pacman": "rust" }` |
| Node.js/TypeScript | ничего не добавлять — `node` уже в базовом списке |

`bootstrap.mjs` кросс-платформенный: сам определяет OS и доступный менеджер пакетов
(`winget`/`brew`/`apt`/`dnf`/`pacman`) — второй раз спрашивать пользователя про ОС не нужно.

## Шаг 5 — GitNexus (если есть код)

Если на шаге 1 пользователь попросил проиндексировать сразу (или в директории уже есть код),
выполни **в корне проекта**:

```bash
gitnexus analyze --skip-agents-md --skip-skills  # глобальный CLI (npm i -g gitnexus); дальше post-commit хук обновляет индекс сам
```

Выполнять **до** шага 7 (sync-rules) — `gitnexus analyze` тоже пишет секцию в `AGENTS.md`, и
порядок "сначала внешние инструменты, потом наш sync-rules последним" гарантирует, что наша
секция довесится, не потеряется и не потеряет чужую.

## Шаг 6 — RAG-индекс (и опционально LightRAG)

```bash
npm run index-docs        # индекс по backlog/docs/, backlog/decisions/
```

Если LightRAG включён — это отдельный, явно тяжёлый шаг, не запускай его молча вместе с
остальным без предупреждения о времени/месте на диске:

```bash
npm run lightrag-setup    # ОДНОРАЗОВО: venv, lightrag-hku, модели Ollama (несколько ГБ)
npm run lightrag-index    # построить граф — минуты, не секунды, на каждый документ
```

`lightrag-setup` сам проверяет Ollama и нужные модели — если Ollama не установлена/не
запущена, скрипт остановится с понятной инструкцией, а не зависнет.

## Шаг 7 — разослать правила

```bash
node scripts/sync-agent-rules.mjs   # infra-dev.md → CLAUDE.md/GEMINI.md/AGENTS.md и .agents/rules/infra-dev.md корня проекта
npm run lint:docs                   # frontmatter/даты/картинки, разделы и ссылки [[id]] + актуальность индекса — должно быть зелёным
npm test                            # тесты git-хуков — должно быть зелёным
```

Проверь, что хуки подключены: `git config core.hooksPath` → `scripts/git-hooks` (или путь
через подпапку инфры). Если корень проекта стал git-репозиторием позже `npm install` —
`npm run install-hooks`.

## Шаг 8 — отчёт пользователю

Кратко перечисли: что создано, что нужно перезапустить агента/IDE, чтобы подхватить
`.mcp.json`/`.agents/mcp_config.json` (`docs-rag`, `env-tools`, `backlog`, `gitnexus`, при выборе —
`docs-graph`, `playwright`), какие git-хуки подключены и что они делают (`pre-commit`: lint:docs;
`commit-msg`: без AI-атрибуции; `post-commit`: переиндексация GitNexus), как поднять веб-интерфейсы
Backlog.md/GitNexus (`node scripts/web.mjs start` или `start-web.bat`/`start-web.sh` в корне
инфраструктуры), и что осталось на усмотрение пользователя (например, LightRAG, если он его
не включил на шаге 1 — можно добавить позже через `node scripts/setup.mjs`).

Роли ProjectHub как нативные субагенты и хуки терминальных сессий (правило 25 `infra-dev.md`) скилл **не
создаёт**: `.claude/agents/*.md`, `.codex/agents/*.toml`, `.projecthub/hooks/projecthub-hook.mjs` и записи
хуков в `.claude/settings.json` / `.codex/hooks.json` генерирует ProjectHub (Роли → «Синхронизация в проект»),
помечая файлы маркером `projecthub:generated`. При повторном запуске скилла в существующем проекте эти файлы
не затирай и не удаляй, `.claude/settings.json` сливай, а не заменяй; `setup.mjs` и `sync-agent-rules.mjs`
их не трогают. Токен хуков — только в переменной окружения `PROJECTHUB_HOOK_TOKEN`, в файлы не пишется.
