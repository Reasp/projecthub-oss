import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ON,
  PLAYWRIGHT_MCP_PACKAGE,
  buildDesiredMcpServers,
  ensureGitignoreEntry,
} from './setup.mjs';

// Фичи computerUse и playwright в setup.mjs (перенесены из ProjectHub, decision-27 и decision-55 там).

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'infra-setup-'));
}

test('computerUse и playwright по умолчанию выключены', () => {
  assert.ok(!DEFAULT_ON.includes('computerUse'));
  assert.ok(!DEFAULT_ON.includes('playwright'));
  const desired = buildDesiredMcpServers('', DEFAULT_ON);
  assert.equal(desired.playwright, undefined);
  assert.equal(desired['projecthub-computer'], undefined);
});

test('playwright: закреплённая версия, headless, профиль в памяти, без опасных флагов', () => {
  const entry = buildDesiredMcpServers('infra/', ['playwright']).playwright;
  assert.deepEqual(entry, { command: 'npx', args: ['--yes', PLAYWRIGHT_MCP_PACKAGE, '--headless', '--isolated'] });
  assert.match(PLAYWRIGHT_MCP_PACKAGE, /^@playwright\/mcp@\d+\.\d+\.\d+$/);
  assert.doesNotMatch(entry.args.join(' '), /--extension|--allow-unrestricted-file-access|--caps|--port/);
});

test('computerUse: stdio-мост из каталога инфраструктуры, токена в конфиге нет', () => {
  const entry = buildDesiredMcpServers('infra/', ['computerUse'])['projecthub-computer'];
  assert.deepEqual(entry, { command: 'node', args: ['infra/scripts/computer-use/computer-use-bridge.mjs'] });
  assert.doesNotMatch(JSON.stringify(entry), /TOKEN|env/);
});

test('.gitignore: дописывает один раз, узнаёт варианты записи, сохраняет CRLF', () => {
  const dir = sandbox();
  try {
    assert.equal(ensureGitignoreEntry(dir, '.playwright-mcp/'), true);
    assert.equal(ensureGitignoreEntry(dir, '.playwright-mcp/'), false);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf-8'), '.playwright-mcp/\n');

    writeFileSync(join(dir, '.gitignore'), 'node_modules/\r\n/.playwright-mcp');
    assert.equal(ensureGitignoreEntry(dir, '.playwright-mcp/'), false);

    writeFileSync(join(dir, '.gitignore'), 'node_modules/\r\ndist');
    assert.equal(ensureGitignoreEntry(dir, '.playwright-mcp/'), true);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf-8'), 'node_modules/\r\ndist\r\n.playwright-mcp/\r\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('настоящий запуск setup.mjs включает и выключает фичи в обоих MCP-конфигах, ручные ключи сохраняются', () => {
  // Копия инфраструктуры: setup.mjs пишет infra.config.json рядом с собой — конфиг шаблона не трогаем.
  const dir = sandbox();
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    for (const f of ['setup.mjs', 'config.mjs']) copyFileSync(join(SCRIPTS, f), join(dir, 'scripts', f));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
    writeFileSync(join(dir, 'infra.config.json'), JSON.stringify({ projectRoot: '.', toolPath: 'C:/tools/x', features: {} }));
    const run = (features) =>
      execFileSync(process.execPath, [join(dir, 'scripts', 'setup.mjs'), '--project-root', '.', '--features', features, '--no-interactive'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const read = (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf-8'));

    const out = run('docsRag,playwright,computerUse');
    assert.match(out, /playwright: Playwright MCP/);
    assert.match(out, /PROJECTHUB_MCP_TOKEN/);
    for (const rel of ['.mcp.json', '.agents/mcp_config.json']) {
      const servers = read(rel).mcpServers;
      assert.ok(servers.playwright.args.includes(PLAYWRIGHT_MCP_PACKAGE), rel);
      assert.equal(servers['projecthub-computer'].command, 'node', rel);
    }
    assert.deepEqual(read('.mcp.json').mcpServers.mine, { command: 'x' });
    assert.equal(read('infra.config.json').toolPath, 'C:/tools/x');
    assert.equal(read('infra.config.json').features.playwright, true);
    assert.equal(read('infra.config.json').features.computerUse, true);
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf-8'), /\.playwright-mcp\//);

    run('docsRag');
    for (const rel of ['.mcp.json', '.agents/mcp_config.json']) {
      const servers = read(rel).mcpServers;
      assert.equal(servers.playwright, undefined, rel);
      assert.equal(servers['projecthub-computer'], undefined, rel);
      assert.ok(servers['docs-rag'], rel);
    }
    assert.equal(read('infra.config.json').features.playwright, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
