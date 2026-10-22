# Contributing to ProjectHub

Thank you for your interest. This page explains how the repositories are organised and how contributions reach the product.

## Two repositories, one source of truth

- **The public repository you are reading is a mirror.** It is generated from the private source repository by a script and contains only what is needed to build the free (open) edition: sources, build configs, resources bundled into the app, and this documentation. Paid modules (`ee/`), tests, the internal task tracker and documentation, agent configs and infrastructure scripts stay in the source. Nobody commits to the mirror directly; its history is rewritten from the source on every release.
- **The source repository is private.** It holds the same open code plus the `ee/` modules of the Team and Enterprise editions under a source-available license (`ee/LICENSE`). Customers of those editions receive the `ee/` sources together with their build.

## Building the open edition

Requirements: Node.js 22 and Git.

```bash
npm install
node scripts/build-info.mjs            # build stamp
npm run build:open                     # desktop app and ph-agent without ee/, bundle check
npm run build:mobile                   # optional: web client for phones
npx electron-builder --win portable    # or: --mac dmg, --linux AppImage, --win --dir for an unpacked build
```

`npm run build:open` sets `PROJECTHUB_EDITION=open` and verifies that no `ee/` code ended up in the bundles. In this mirror `ee/` does not exist, so every build here is an open-edition build.

## Pull requests

- Open PRs against this mirror. A maintainer transfers accepted changes into the private source with `git cherry-pick`, runs the full check suite there (lint, tests, builds) and the change appears here with the next mirror update. Your authorship is kept in the commit.
- The open edition is MIT-licensed. By submitting a PR you agree that your contribution is licensed under MIT.
- Contributions to `ee/` are not accepted until a contributor license agreement exists. Everything outside `ee/` is open to contributions.
- Before opening a PR make sure `npm run build:open` passes. Keep user-facing strings in the i18n dictionaries (`src/i18n/en.ts` and `src/i18n/ru.ts`): English first, Russian in the same change.
- Commit messages: a short imperative subject, e.g. `fix(git): keep stash list after worktree removal`. Do not add AI co-author trailers.

## Issues

Use the issue templates: **Bug report** for something that breaks, **Feature request** for something ProjectHub should do. Security problems go through [SECURITY.md](SECURITY.md), not the public tracker.

## Documentation

Internal tasks, documentation and architecture decisions live in the private source repository and are not part of the mirror. User documentation in English lives on the website.
