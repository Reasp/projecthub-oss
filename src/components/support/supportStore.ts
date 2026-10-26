import { create } from 'zustand';
import { edition } from 'virtual:projecthub-edition/renderer';
import productLinks from '../../lib/productLinks.json';
import reminderConfig from '../../lib/supportReminderConfig.json';
import {
  addDone,
  answerSupportReminder,
  markSupported,
  parseSupportReminderState,
  shouldShowSupportReminder,
  supportUrl,
  type SupportReminderState
} from '../../lib/supportReminder';

/**
 * Кнопка поддержки и напоминание открытой редакции (TASK-144.6, decision-170). В сборке с `ee/` их нет: редакция —
 * константа сборки, проверок лицензии в клиенте нет (decision-86 п. 7). Состояние напоминания — в localStorage окна,
 * то есть в userData; в сеть ничего не уходит, ссылка открывается только по клику.
 */
export const SUPPORT_ENABLED = edition === 'open';
export const SUPPORT_URL = supportUrl(productLinks);

const STORAGE_KEY = 'projecthub_support_reminder';

function load(): SupportReminderState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // без localStorage — состояние только на этот запуск
  }
  return parseSupportReminderState(raw, Date.now());
}

function save(state: SupportReminderState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // см. load
  }
}

interface SupportStore {
  state: SupportReminderState;
  /** Полоса видна в этом запуске: решение принимается при подсчёте задач, а не на каждом рендере. */
  reminderVisible: boolean;
  noteDone: (count: number) => void;
  openSupport: (from: 'button' | 'reminder') => void;
  remindLater: () => void;
}

export const useSupportStore = create<SupportStore>((set, get) => {
  const initial = load();
  save(initial);
  return {
    state: initial,
    reminderVisible: SUPPORT_ENABLED && shouldShowSupportReminder(initial, Date.now(), reminderConfig),
    noteDone: (count) => {
      const next = addDone(get().state, count);
      if (next === get().state) return;
      save(next);
      set({ state: next, reminderVisible: get().reminderVisible || (SUPPORT_ENABLED && shouldShowSupportReminder(next, Date.now(), reminderConfig)) });
    },
    openSupport: (from) => {
      set({ reminderVisible: false });
      if (!SUPPORT_URL || !window.api) return;
      // «Поддержал» засчитывается, только если ссылка действительно открылась: иначе пауза 90 дней без причины.
      void window.api.openExternal(SUPPORT_URL).then((opened) => {
        const now = Date.now();
        const state = get().state;
        const next = opened
          ? from === 'reminder'
            ? answerSupportReminder(state, 'support', now)
            : markSupported(state, now)
          : from === 'reminder'
            ? answerSupportReminder(state, 'later', now)
            : state;
        if (next === state) return;
        save(next);
        set({ state: next });
      });
    },
    remindLater: () => {
      const next = answerSupportReminder(get().state, 'later', Date.now());
      save(next);
      set({ state: next, reminderVisible: false });
    }
  };
});
