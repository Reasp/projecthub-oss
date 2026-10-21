/**
 * Тонкая обвязка над GitNexus CLI для контекста агента (TASK-64, decision-18).
 *
 * Обзор файла — один запрос `gitnexus cypher` (TASK-168): символы файла, кто их вызывает и что вызывают они.
 * `context -f <файл>` в GitNexus 1.6 больше не работает без имени символа, а запрос на символ стоит ~4 с
 * запуска CLI. Таблицу markdown из ответа берём как есть — это и есть формат для системного промпта LLM.
 * Репозиторий указывается явно (`-r <корень проекта>`): при нескольких индексах CLI без него отказывает.
 * Любая ошибка (CLI не установлен, репозиторий не проиндексирован, индекс занят) не должна ронять сборку
 * контекста — только пропускать секцию GitNexus.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveNodeCli } from './npmCmdShim';

const TIMEOUT_MS = 8000;
/** Больше файлов в контекст не берём: каждый — отдельный запуск CLI. */
const MAX_FILES = 5;

/** Строковый литерал Cypher: путь файла из references задачи не выходит за кавычки. */
export function cypherString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Путь файла так, как он записан в графе GitNexus: относительно корня проекта, через `/`. `null` — путь вне
 * проекта или с управляющими символами.
 */
export function graphFilePath(projectPath: string, file: string): string | null {
  const raw = file.trim();
  // eslint-disable-next-line no-control-regex -- управляющие символы в пути — признак мусора, а не файла
  if (!raw || /[\u0000-\u001f]/.test(raw)) return null;
  let rel = raw;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    rel = path.relative(projectPath, raw);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  }
  rel = rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return rel && !rel.startsWith('../') ? rel : null;
}

/** Обзор файла одним запросом: символы, вызывающие их (с файлом) и вызываемые ими; самые вызываемые сверху. */
export function fileOverviewQuery(graphPath: string, limit: number): string {
  return [
    `MATCH (f:File)-[d:CodeRelation]->(s) WHERE f.filePath = ${cypherString(graphPath)} AND d.type = 'DEFINES'`,
    `AND label(s) IN ['Function','Class','Method','Interface']`,
    `OPTIONAL MATCH (a)-[c:CodeRelation]->(s) WHERE c.type = 'CALLS' AND a.id <> f.id`,
    // Без CASE символ без вызывающих получил бы ":" (null + строка); size() считает null, поэтому порядок — по count.
    `WITH s, count(DISTINCT a) AS n, collect(DISTINCT CASE WHEN a IS NULL THEN NULL ELSE a.filePath + ':' + a.name END) AS callers`,
    `OPTIONAL MATCH (s)-[o:CodeRelation]->(b) WHERE o.type = 'CALLS'`,
    `WITH s, n, callers, collect(DISTINCT b.name) AS callees`,
    `RETURN label(s) AS kind, s.name AS symbol, s.startLine AS line, callers, callees`,
    `ORDER BY n DESC LIMIT ${Math.max(1, Math.floor(limit))}`
  ].join(' ');
}

/** Таблица markdown из ответа `gitnexus cypher` (`{ markdown, row_count }`); пустой результат — `null`. */
export function parseCypherTable(output: string | null): string | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as { markdown?: unknown; row_count?: unknown };
    if (!parsed || typeof parsed.markdown !== 'string' || !parsed.markdown.trim()) return null;
    if (typeof parsed.row_count === 'number' && parsed.row_count === 0) return null;
    return parsed.markdown.trim();
  } catch {
    return null;
  }
}

function runGitNexus(args: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  // На Windows gitnexus — npm-обёртка .cmd: запускаем её JS-точку входа через node, без оболочки, — пути файлов
  // из references задачи не разбирает cmd.exe (TASK-168).
  const cli = resolveNodeCli('gitnexus');
  return new Promise((resolve) => {
    execFile(cli.command, [...cli.prefixArgs, ...args], { cwd, timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const trimmed = stdout?.trim();
      resolve(trimmed || null);
    });
  });
}

export interface GitNexusContextOptions {
  projectPath: string;
  /** Пути файлов (обычно из `references` задачи), для каждого запрашивается обзор связей. */
  files: string[];
  /** Сколько символов файла показывать (самые вызываемые). */
  limitPerFile?: number;
}

/** Текстовые секции `### <file>` с обзором GitNexus по каждому файлу; пустая строка, если нечего показать. */
export async function fetchGitNexusContext(options: GitNexusContextOptions): Promise<string> {
  const { projectPath, files, limitPerFile = 5 } = options;
  const sections: string[] = [];

  for (const file of files.slice(0, MAX_FILES)) {
    const graphPath = graphFilePath(projectPath, file);
    if (!graphPath) continue;
    const output = await runGitNexus(['cypher', fileOverviewQuery(graphPath, limitPerFile), '-r', projectPath], projectPath);
    const table = parseCypherTable(output);
    if (table) sections.push(`### ${file}\n${table}`);
  }

  return sections.join('\n\n');
}

/** Метрики радиуса изменения по `gitnexus detect-changes` (TASK-61). */
export interface GitNexusDiffImpact {
  changedFiles?: number;
  /** Индексированные символы, задетые диффом, — «число зависимых символов» в скоринге. */
  changedSymbols?: number;
  affectedProcesses?: number;
  riskLevel?: string;
}

/**
 * Разбор человекочитаемого вывода `gitnexus detect-changes` (JSON он не отдаёт, проверено
 * `gitnexus detect-changes --help`, 2026-09-11). Чистая функция — покрыта unit-тестами.
 */
export function parseDetectChangesOutput(output: string): GitNexusDiffImpact | null {
  const text = output ?? '';
  if (!text.trim()) return null;
  if (/^No changes detected\.?$/im.test(text.trim())) return { changedFiles: 0, changedSymbols: 0 };

  const changes = /Changes:\s*(\d+)\s*files?,\s*(\d+)\s*symbols?/i.exec(text);
  const processes = /Affected processes:\s*(\d+)/i.exec(text);
  const risk = /Risk level:\s*(\w+)/i.exec(text);
  if (!changes && !processes && !risk) return null;

  return {
    ...(changes ? { changedFiles: Number.parseInt(changes[1], 10), changedSymbols: Number.parseInt(changes[2], 10) } : {}),
    ...(processes ? { affectedProcesses: Number.parseInt(processes[1], 10) } : {}),
    ...(risk ? { riskLevel: risk[1].toLowerCase() } : {})
  };
}

/**
 * Радиус изменений worktree кандидата относительно базовой ветки. Требует проиндексированного
 * репозитория; любая ошибка (нет бинарника, нет индекса, несколько репозиториев без `--repo`)
 * возвращает `null` — метрика просто не участвует в скоринге.
 */
export async function fetchDiffImpact(options: {
  /** Каталог, в котором запускается CLI: worktree кандидата либо корень проекта. */
  cwd: string;
  baseRef: string;
  /** Имя репозитория в реестре GitNexus, если индексов несколько. */
  repo?: string;
  timeoutMs?: number;
}): Promise<GitNexusDiffImpact | null> {
  const args = ['detect-changes', '--scope', 'compare', '--base-ref', options.baseRef, '--limit', '1'];
  if (options.repo) args.push('--repo', options.repo);
  const output = await runGitNexus(args, options.cwd, options.timeoutMs ?? TIMEOUT_MS);
  return output ? parseDetectChangesOutput(output) : null;
}
