/*
 * projecthub:generated — плагин ProjectHub для Obsidian (TASK-178, decision-133).
 * Файл кладёт ProjectHub в `.obsidian/plugins/projecthub-links/` хранилища `backlog/` и перезаписывает
 * при каждом «Открыть в Obsidian»; править здесь бесполезно.
 *
 * Obsidian сопоставляет `[[…]]` с именем файла, а файлы Backlog.md называются `decision-68 - Заголовок.md`,
 * поэтому `[[decision-68]]`, `[[TASK-175]]`, `[[doc-5]]`, `[[mem-3]]` у него неразрешённые. Плагин дополняет
 * поиск файла по ссылке: если Obsidian файл не нашёл, а цель ссылки — идентификатор Backlog.md, берётся файл,
 * имя которого начинается с этого идентификатора. Остальные ссылки Obsidian разрешает как обычно.
 */
'use strict';

const obsidian = require('obsidian');

const ID_PATTERN = /^(?:decision|doc|task|mem)-\d+(?:\.\d+)*$/i;
const FILE_PATTERN = /^((?:decision|doc|task|mem)-\d+(?:\.\d+)*)(?:\s+-\s.*)?$/i;

/** Идентификатор Backlog.md из цели ссылки (`TASK-175`, `decision-68#Decision`) или `null`. */
function linkId(linkpath) {
  if (typeof linkpath !== 'string') return null;
  const target = linkpath.split('#')[0].trim();
  return ID_PATTERN.test(target) ? target.toLowerCase() : null;
}

/** Чем меньше, тем лучше: рабочие файлы раньше черновиков, выполненных и архива с тем же номером. */
function pathRank(filePath) {
  const p = filePath.toLowerCase();
  if (/(^|\/)archive\//.test(p)) return 3;
  if (/(^|\/)completed\//.test(p)) return 2;
  if (/(^|\/)drafts\//.test(p)) return 1;
  return 0;
}

/** Индекс «идентификатор → файл» по markdown-файлам хранилища. */
function buildIndex(files) {
  const index = new Map();
  for (const file of files) {
    const match = FILE_PATTERN.exec(file.basename);
    if (!match) continue;
    const id = match[1].toLowerCase();
    const current = index.get(id);
    if (!current || pathRank(file.path) < pathRank(current.path) || (pathRank(file.path) === pathRank(current.path) && file.path < current.path)) {
      index.set(id, file);
    }
  }
  return index;
}

class ProjectHubLinksPlugin extends obsidian.Plugin {
  onload() {
    this.index = null;
    const cache = this.app.metadataCache;
    const original = cache.getLinkpathDest;
    if (typeof original !== 'function') {
      console.warn('[ProjectHub] metadataCache.getLinkpathDest не найден — ссылки [[id]] не разрешаются');
      return;
    }
    const hadOwn = Object.prototype.hasOwnProperty.call(cache, 'getLinkpathDest');
    // getFirstLinkpathDest, граф, обратные ссылки и переход по клику идут через getLinkpathDest.
    cache.getLinkpathDest = (linkpath, sourcePath) => {
      const found = original.call(cache, linkpath, sourcePath);
      if (Array.isArray(found) && found.length > 0) return found;
      const file = this.resolveId(linkpath);
      return file ? [file] : found;
    };
    this.register(() => {
      if (hadOwn) cache.getLinkpathDest = original;
      else delete cache.getLinkpathDest;
    });

    const invalidate = () => {
      this.index = null;
    };
    this.registerEvent(this.app.vault.on('create', invalidate));
    this.registerEvent(this.app.vault.on('delete', invalidate));
    this.registerEvent(this.app.vault.on('rename', invalidate));

    // Ссылки, разрешённые до загрузки плагина, Obsidian запомнил как неразрешённые — пересчитываем их.
    this.app.workspace.onLayoutReady(() => this.reresolve());
    const onFirstResolved = cache.on('resolved', () => {
      cache.offref(onFirstResolved);
      this.reresolve();
    });
    this.registerEvent(onFirstResolved);
  }

  resolveId(linkpath) {
    const id = linkId(linkpath);
    if (!id) return null;
    if (!this.index) this.index = buildIndex(this.app.vault.getMarkdownFiles());
    return this.index.get(id) || null;
  }

  /** Пересчёт связей у файлов, где остались неразрешённые ссылки вида `[[id]]`. */
  reresolve() {
    const cache = this.app.metadataCache;
    if (typeof cache.resolveLinks !== 'function') return;
    let changed = 0;
    for (const [sourcePath, unresolved] of Object.entries(cache.unresolvedLinks || {})) {
      if (!Object.keys(unresolved).some((link) => this.resolveId(link))) continue;
      cache.resolveLinks(sourcePath);
      changed++;
    }
    if (changed > 0) cache.trigger('resolved');
  }
}

module.exports = ProjectHubLinksPlugin;
module.exports.default = ProjectHubLinksPlugin;
module.exports.linkId = linkId;
module.exports.buildIndex = buildIndex;
