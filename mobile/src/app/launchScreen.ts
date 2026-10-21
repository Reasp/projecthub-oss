/**
 * Анимированный Launch Screen приложения (разметка и CSS — в `targets/capacitor/index.html`). Во встроенном клиенте и
 * Telegram Mini App элемента нет, и всё здесь ничего не делает.
 *
 * Заставка стоит на паузе, пока её закрывает системный экран Android, и стартует по классу `l-go`: его ставит
 * MainActivity, когда системный экран ушёл, а если сигнал не пришёл за `INTRO_FALLBACK_MS` — этот модуль.
 *
 * Экран уходит, когда открытый ПК ответил (связь есть, ждёт одобрения или не удалась), — так после заставки не мелькают
 * пустые списки. Раньше `LAUNCH_MIN_MS` от старта заставки не уходит, чтобы она доиграла; позже `LAUNCH_MAX_MS` не
 * держится, даже если ПК молчит: дальше о связи говорит баннер подключения.
 */

export const LAUNCH_MIN_MS = 1500;
export const LAUNCH_MAX_MS = 3000;
const INTRO_FALLBACK_MS = 3000;
const EXIT_MS = 400;

const SETTLED = new Set(['ready', 'awaiting_approval', 'failed']);

/**
 * `introMs` — сколько играет заставка. `waitHost` — есть сохранённый ПК, к которому клиент подключается при запуске;
 * без него сразу экран сопряжения.
 */
export function launchScreenDone(introMs: number, waitHost: boolean, connState: string): boolean {
  if (introMs < LAUNCH_MIN_MS) return false;
  if (!waitHost) return true;
  return SETTLED.has(connState) || introMs >= LAUNCH_MAX_MS;
}

/** Следит за заставкой и связью и убирает экран, когда пора. Возвращает отписку. */
export function watchLaunchScreen(waitHost: boolean, connState: () => string): () => void {
  const el = typeof document === 'undefined' ? null : document.getElementById('launch');
  if (!el || el.classList.contains('l-out')) return () => undefined;
  const watchedAt = performance.now();
  let introAt: number | null = null;
  const timer = setInterval(() => {
    const now = performance.now();
    if (introAt === null) {
      if (!el.classList.contains('l-go')) {
        if (now - watchedAt < INTRO_FALLBACK_MS) return;
        el.classList.add('l-go');
      }
      introAt = now;
    }
    if (!launchScreenDone(now - introAt, waitHost, connState())) return;
    clearInterval(timer);
    el.classList.add('l-out');
    setTimeout(() => el.remove(), EXIT_MS);
  }, 100);
  return () => clearInterval(timer);
}
