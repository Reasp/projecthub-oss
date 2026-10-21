/**
 * Пункт плана инициализации «индексация кода» (decision-131, TASK-176): блок ProjectHub в `.gitnexusignore`
 * по профилю, предложенному для найденного стека. Не часть основы ([[decision-78]]): GitNexus нужен не
 * каждому проекту, поэтому пункт включён по умолчанию, только когда GitNexus в проекте уже есть или его
 * ставит шаблон. Чистый модуль (правило 17).
 */
import type { InitPlanItem } from './initFoundation.js';
import {
  defaultIndexSettings,
  INDEX_PROFILES,
  parseGitnexusIgnore,
  renderIndexBlock,
  upsertIndexBlock,
  type CodeIndexSettings,
  type IndexContext,
  type IndexLocale,
  type IndexProfileId
} from './codeIndexProfiles.js';

export const INDEX_ITEM_ID = 'index:.gitnexusignore';

export interface InitIndexView {
  /** Профили по найденному стеку. */
  suggested: IndexProfileId[];
  /** Профили, по которым построен пункт. */
  selected: IndexProfileId[];
  profiles: Array<{ id: IndexProfileId; label: string }>;
  /** Найденные плагины маркетплейса UE. */
  marketplacePlugins: string[];
}

export interface InitIndexInput {
  /** Текущий `.gitnexusignore`; `null` — нет. */
  existing: string | null;
  suggested: IndexProfileId[];
  /** Выбор в окне; не задан — профили из блока, а без блока — предложенные. */
  requested?: IndexProfileId[];
  context: IndexContext;
  locale: IndexLocale;
  /** Писать по умолчанию: GitNexus уже в проекте или его включает шаблон. */
  enabledByDefault: boolean;
}

/** Настройки для выбранных профилей: сохранённые, если профили те же, иначе — по умолчанию со своими шаблонами. */
function settingsFor(saved: CodeIndexSettings | null, selected: IndexProfileId[]): CodeIndexSettings {
  const same = saved && saved.profiles.length === selected.length && saved.profiles.every((id) => selected.includes(id));
  if (saved && same) return saved;
  return { ...defaultIndexSettings(selected), custom: saved?.custom ?? [] };
}

export function buildIndexItem(input: InitIndexInput): { item: InitPlanItem; view: InitIndexView } {
  const parsed = parseGitnexusIgnore(input.existing);
  const selected = input.requested ?? parsed.settings?.profiles ?? input.suggested;
  const view: InitIndexView = {
    suggested: input.suggested,
    selected,
    profiles: INDEX_PROFILES.map((profile) => ({ id: profile.id, label: profile.label[input.locale] })),
    marketplacePlugins: input.context.marketplacePlugins
  };
  const detail = INDEX_PROFILES.filter((profile) => selected.includes(profile.id)).map((profile) => profile.label[input.locale]).join(', ') || undefined;
  const base = { id: INDEX_ITEM_ID, path: '.gitnexusignore', kind: 'file' as const, group: 'index' as const, detail };

  if (parsed.broken) return { item: { ...base, action: 'skip', options: ['skip'], reason: 'config-unreadable' }, view };

  const next = upsertIndexBlock(input.existing, renderIndexBlock(settingsFor(parsed.settings, selected), input.context, input.locale));
  const on = input.enabledByDefault;
  if (input.existing === null) {
    return { item: { ...base, action: on ? 'create' : 'skip', options: ['create', 'skip'], reason: 'missing', contents: { create: next } }, view };
  }
  if (next === input.existing) return { item: { ...base, action: 'skip', options: ['skip'], reason: 'up-to-date' }, view };
  return {
    item: {
      ...base,
      action: on ? 'merge' : 'skip',
      options: ['merge', 'skip'],
      reason: parsed.hasBlock ? 'section-outdated' : 'section-missing',
      contents: { merge: next }
    },
    view
  };
}
