import fs from 'node:fs';
import path from 'node:path';

/**
 * Редакция сборки и платные модули (TASK-151, decision-123).
 *
 * Платные модули Team/Enterprise лежат в `ee/` под своей лицензией (`ee/LICENSE`). Открытый код их не
 * импортирует напрямую: он читает виртуальный модуль `virtual:projecthub-edition/<цель>`, а этот плагин
 * подставляет в него модули из `ee/` — или пустой список, если каталога нет или сборка открытая
 * (`PROJECTHUB_EDITION=open`). Так открытая сборка собирается и работает без `ee/`, а в клиенте нет проверок
 * «куплено или нет» (decision-86 п. 7): платные возможности просто живут в другом коде.
 *
 * Цели: `main` — `ee/electron/<модуль>/index.ts` (main-процесс и ph-agent), `renderer` —
 * `ee/src/<модуль>/index.tsx|ts`. У каждой цели свой id, поэтому один плагин в общем списке плагинов не
 * подставит модули рендерера в main.
 */
const VIRTUAL_PREFIX = 'virtual:projecthub-edition/';

const TARGET_DIRS = {
  main: 'electron',
  renderer: 'src'
};

/** Открытая ли сборка: явный флаг или нет `ee/LICENSE`. */
export function resolveEdition(root, env = process.env) {
  if (String(env.PROJECTHUB_EDITION ?? '').trim().toLowerCase() === 'open') return 'open';
  return fs.existsSync(path.join(root, 'ee', 'LICENSE')) ? 'team' : 'open';
}

/** Точки входа модулей `ee/` для цели сборки, по имени модуля — порядок регистрации стабилен. */
export function findEditionModules(root, target) {
  const sub = TARGET_DIRS[target];
  if (!sub) return [];
  const base = path.join(root, 'ee', sub);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const name of fs.readdirSync(base).sort()) {
    const entry = ['index.ts', 'index.tsx'].map((file) => path.join(base, name, file)).find((file) => fs.existsSync(file));
    if (entry) out.push(entry);
  }
  return out;
}

export function editionModuleSource(edition, entries) {
  const list = edition === 'open' ? [] : entries;
  const lines = list.map((entry, i) => `import * as m${i} from ${JSON.stringify(entry.split(path.sep).join('/'))};`);
  lines.push(`export const edition = ${JSON.stringify(edition)};`);
  lines.push(`export const modules = [${list.map((_, i) => `m${i}`).join(', ')}];`);
  return lines.join('\n');
}

export function projecthubEdition({ root = process.cwd(), env = process.env } = {}) {
  return {
    name: 'projecthub-edition',
    resolveId(id) {
      return id.startsWith(VIRTUAL_PREFIX) ? `\0${id}` : null;
    },
    load(id) {
      if (!id.startsWith(`\0${VIRTUAL_PREFIX}`)) return null;
      const target = id.slice(VIRTUAL_PREFIX.length + 1);
      if (!TARGET_DIRS[target]) throw new Error(`projecthub-edition: неизвестная цель ${target}`);
      return editionModuleSource(resolveEdition(root, env), findEditionModules(root, target));
    }
  };
}
