#!/usr/bin/env node
// Возвращает документу или решению Backlog.md поле `section` (и при желании `description`) во frontmatter
// (правило 14 infra-dev.md). `backlog doc update` и MCP `document_update` стирают неизвестные CLI поля
// (проверено на CLI 1.50.1) — после обновления документа раздел нужно вернуть; этот скрипт меняет ровно
// нужные строки frontmatter и не трогает остальное (кавычки, порядок, LF/CRLF, updated_date).
// Перенесён из WorldSim (TASK-411 там).
//
//   node scripts/set-doc-section.mjs doc-5 "Инфраструктура/RAG"                    # один документ, пишет сразу
//   node scripts/set-doc-section.mjs doc-5 "Инфраструктура/RAG" --description "…"  # заодно вернуть описание
//   node scripts/set-doc-section.mjs --map sections.json [--write]                 # пакетно; без --write — прогон без записи
// Файл карты — JSON вида {"Раздел/Подраздел": ["doc-5", "decision-2", 17]} (число = doc-N).
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.mjs';
import { DOC_ROOTS, sectionFieldError, withFrontmatterField, withSection } from './doc-rules.mjs';

const ROOT = PROJECT_ROOT;
const args = process.argv.slice(2);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/** Файлы документов и решений по id (`doc-5` → путь от корня); дубль id хранится списком, чтобы запись отказала. */
function indexDocFiles() {
  const byId = new Map();
  for (const root of DOC_ROOTS) {
    const abs = path.join(ROOT, root);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
      const id = e.isFile() && e.name.match(/^((?:doc|decision)-\d+) - .*\.md$/)?.[1];
      if (!id) continue;
      const rel = path.relative(ROOT, path.join(e.parentPath ?? e.path, e.name));
      byId.set(id, byId.has(id) ? [].concat(byId.get(id), rel) : rel);
    }
  }
  return byId;
}

function parseMap(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const plan = new Map();
  for (const [section, ids] of Object.entries(raw)) {
    if (section.startsWith('_')) continue;
    for (const item of ids) {
      const id = typeof item === 'number' ? `doc-${item}` : String(item).toLowerCase();
      if (plan.has(id)) fail(`${id} указан в двух разделах: «${plan.get(id)}» и «${section}»`);
      plan.set(id, section);
    }
  }
  return plan;
}

const files = indexDocFiles();
let plan;
let write;
let description = null;
if (args[0] === '--map') {
  if (!args[1]) fail('после --map нужен путь к JSON-файлу карты');
  plan = parseMap(args[1]);
  write = args.includes('--write');
} else if (args.length >= 2) {
  plan = new Map([[args[0].toLowerCase(), args[1]]]);
  write = true;
  const d = args.indexOf('--description');
  if (d !== -1) {
    description = args[d + 1];
    if (!description) fail('после --description нужен текст описания');
  }
} else {
  fail('использование: set-doc-section.mjs <doc-N|decision-N> "<Раздел/Подраздел>" [--description "…"] | --map <файл.json> [--write]');
}

for (const [id, section] of plan) {
  if (!files.has(id)) fail(`нет документа или решения ${id}`);
  if (Array.isArray(files.get(id))) fail(`${id} есть в нескольких файлах (${files.get(id).join(', ')}) — сначала дайте документу свой номер`);
  const error = sectionFieldError(section);
  if (error) fail(`${id}: ${error}`);
}

let changed = 0;
for (const [id, section] of plan) {
  const full = path.join(ROOT, files.get(id));
  const current = fs.readFileSync(full, 'utf-8');
  let next = withSection(current, section);
  if (description !== null) next = withFrontmatterField(next ?? current, 'description', description) ?? next;
  if (next === null) continue;
  changed++;
  if (write) fs.writeFileSync(full, next, 'utf-8');
}

console.log(`${write ? 'Записано' : 'Прогон без записи'}: frontmatter изменится у ${changed} из ${plan.size} файлов.`);
if (args[0] === '--map') {
  const counts = new Map();
  for (const section of plan.values()) counts.set(section, (counts.get(section) ?? 0) + 1);
  for (const [section, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) console.log(`  ${section}: ${n}`);
  const unmapped = [...files.keys()].filter((id) => !plan.has(id));
  if (unmapped.length > 0) console.log(`Без раздела в карте: ${unmapped.join(', ')}`);
}
