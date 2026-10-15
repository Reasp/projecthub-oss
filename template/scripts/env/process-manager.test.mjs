import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Живая проверка process-manager.mjs (env-tools): процесс реально запускается, пишет лог, виден в
// реестре и останавливается вместе с деревом. Регрессионный страж для Windows: прямой detached-spawn
// powershell.exe молча не стартует (ProjectHub decision-58), и тест упал бы на startProcess. Скрипты
// копируются во временный INFRA_ROOT, чтобы не трогать реестр `.env-state` проекта.
//
// ProjectHub TASK-110, decision-59: запись реестра хранит время старта процесса (pidCreatedAt), и pid,
// который ОС отдала другому процессу, не считается ни работающим, ни дубликатом, а stop_process его не
// убивает.
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'ticker';
const DAY_MS = 24 * 60 * 60 * 1000;
// Заведомо несуществующий pid (на Windows pid кратны 4 и намного меньше).
const DEAD_PID = 2147483644;
let root;
let pm;
let state;
let foreign;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-env-pm-'));
  fs.mkdirSync(path.join(root, 'scripts', 'env'), { recursive: true });
  fs.copyFileSync(path.join(SCRIPTS, 'config.mjs'), path.join(root, 'scripts', 'config.mjs'));
  for (const f of ['state.mjs', 'process-manager.mjs']) {
    fs.copyFileSync(path.join(SCRIPTS, 'env', f), path.join(root, 'scripts', 'env', f));
  }
  fs.writeFileSync(path.join(root, 'infra.config.json'), JSON.stringify({ projectRoot: '.' }));
  // Тикер пишет свой pid — по нему проверяем, что остановка убивает всё дерево, а не только обёртку.
  fs.writeFileSync(
    path.join(root, 'ticker.cjs'),
    "require('fs').writeFileSync('ticker.pid', String(process.pid));\n" +
      "setInterval(() => console.log('tick ' + Date.now()), 200);\n",
  );
  pm = await import(pathToFileURL(path.join(root, 'scripts', 'env', 'process-manager.mjs')).href);
  state = await import(pathToFileURL(path.join(root, 'scripts', 'env', 'state.mjs')).href);
});

after(async () => {
  foreign?.kill();
  if (!root) return;
  for (const name of [NAME, 'restartable']) {
    try {
      pm?.stopProcess({ name });
    } catch {
      // уже остановлен тестом
    }
  }
  // Каталог был cwd убитого процесса — на Windows ОС отпускает его с задержкой.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

function registryFile() {
  return path.join(root, '.env-state', 'processes.json');
}

function writeRegistry(registry) {
  fs.mkdirSync(path.join(root, '.env-state', 'logs'), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(registry, null, 2));
}

test('env-tools: запуск, лог, отказ дубликату, остановка всего дерева', { timeout: 60_000 }, async () => {
  const before = Date.now();
  const entry = pm.startProcess({ name: NAME, command: 'node ticker.cjs', cwd: root });
  assert.ok(entry.pid > 0);
  assert.ok(isAlive(entry.pid));
  // Время старта процесса по данным ОС — в пределах запуска (с допуском на округление).
  assert.ok(entry.pidCreatedAt >= before - 1000 && entry.pidCreatedAt <= Date.now() + 1000, 'pidCreatedAt');

  assert.ok(await waitFor(() => pm.tailLog({ name: NAME, lines: 5 }).includes('tick '), 30_000), 'лог пуст');
  const { processes: listed, pruned } = pm.listProcesses();
  assert.deepEqual(pruned, []);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].pid, entry.pid);
  assert.equal(listed[0].status, 'running');
  assert.equal(listed[0].alive, true);
  assert.throws(() => pm.startProcess({ name: NAME, command: 'node ticker.cjs', cwd: root }), /уже запущен/);

  if (process.platform === 'win32') {
    // Обёртка — не наш потомок (её родитель — завершившийся cmd.exe из `start /b`), поэтому
    // `taskkill /T` по хосту env-server её не заденет.
    const ppid = Number(
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${entry.pid}").ParentProcessId`,
      ]).toString().trim(),
    );
    assert.notEqual(ppid, process.pid);
  }

  const tickerPidFile = path.join(root, 'ticker.pid');
  assert.ok(await waitFor(() => fs.existsSync(tickerPidFile), 10_000));
  const tickerPid = Number(fs.readFileSync(tickerPidFile, 'utf-8'));

  assert.deepEqual(pm.stopProcess({ name: NAME }), { name: NAME, pid: entry.pid, status: 'running', killed: true });
  assert.deepEqual(pm.listProcesses(), { processes: [], pruned: [] });
  assert.ok(await waitFor(() => !isAlive(entry.pid) && !isAlive(tickerPid), 15_000), 'дерево не остановлено');
});

test('env-tools: переиспользованный PID не считается ни работающим, ни дубликатом и не убивается', { timeout: 60_000 }, async () => {
  // «Посторонний» процесс, которому ОС будто бы отдала pid записей реестра.
  foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const pid = foreign.pid;
  assert.ok(await waitFor(() => isAlive(pid), 5_000));

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const base = { command: 'node server.js', cwd: root };
  writeRegistry({
    // Время старта записано и не совпадает с временем старта процесса, занявшего pid.
    reused: { ...base, pid, pidCreatedAt: now - 3_600_000, startedAt: iso(now - 3_600_000) },
    // Старая запись без идентичности, но pid занят процессом, созданным позже записи, — точно чужой.
    // Заодно мёртвая больше 7 дней — list_processes её удалит.
    legacyReused: { ...base, pid, startedAt: iso(now - 30 * DAY_MS) },
    // Старая запись без идентичности, процесс создан раньше записи — сопоставить нельзя.
    legacyUnknown: { ...base, pid, startedAt: iso(now + 60_000) },
    restartable: { ...base, pid, startedAt: iso(now + 60_000) },
    // Мёртвые: давняя удаляется вместе с логом, недавняя остаётся как «НЕ работает».
    stale: { ...base, pid: DEAD_PID, pidCreatedAt: now - 30 * DAY_MS, startedAt: iso(now - 30 * DAY_MS) },
    recentDead: { ...base, pid: DEAD_PID, pidCreatedAt: now - DAY_MS, startedAt: iso(now - DAY_MS) },
  });
  const staleLog = path.join(root, '.env-state', 'logs', 'stale.log');
  fs.writeFileSync(staleLog, 'old\n');
  fs.utimesSync(staleLog, new Date(now - 30 * DAY_MS), new Date(now - 30 * DAY_MS));

  const { processes, pruned } = pm.listProcesses();
  assert.deepEqual(pruned.sort(), ['legacyReused', 'stale']);
  assert.equal(fs.existsSync(staleLog), false);
  assert.deepEqual(Object.fromEntries(processes.map((p) => [p.name, p.status])), {
    reused: 'dead',
    legacyUnknown: 'unknown',
    restartable: 'unknown',
    recentDead: 'dead',
  });
  assert.ok(processes.every((p) => p.alive === (p.status === 'running')));

  assert.deepEqual(pm.stopProcess({ name: 'reused' }), { name: 'reused', pid, status: 'dead', killed: false });
  assert.deepEqual(pm.stopProcess({ name: 'legacyUnknown' }), {
    name: 'legacyUnknown',
    pid,
    status: 'unknown',
    killed: false,
  });

  // Запись 'unknown' не мешает запустить процесс под тем же именем; новая запись — с идентичностью.
  const restarted = pm.startProcess({ name: 'restartable', command: 'node ticker.cjs', cwd: root });
  assert.notEqual(restarted.pid, pid);
  assert.equal(typeof restarted.pidCreatedAt, 'number');
  const stopped = pm.stopProcess({ name: 'restartable' });
  assert.equal(stopped.status, 'running');
  assert.equal(stopped.killed, true);

  // Посторонний процесс пережил все остановки, в реестре осталась только недавняя мёртвая запись.
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(isAlive(pid), 'посторонний процесс убит');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(registryFile(), 'utf-8'))), ['recentDead']);
});

test('env-tools: разбор времени старта из вывода Get-Process и ps -o pid=,lstart=', () => {
  const win = state.parseStartTimes('1234,1790000000123\r\n4,\r\nмусор\r\n');
  assert.deepEqual([...win], [
    [1234, 1790000000123],
    [4, null],
  ]);
  const posix = state.parseStartTimes('    1 Mon Sep 28 08:38:51 2026\n  777 Tue Sep 29 00:00:05 2026\n');
  assert.equal(posix.get(1), new Date(2026, 8, 28, 8, 38, 51).getTime());
  assert.equal(posix.get(777), new Date(2026, 8, 29, 0, 0, 5).getTime());
});
