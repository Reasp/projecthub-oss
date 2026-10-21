/**
 * Ссылки `projecthub://` (TASK-186, decision-143 п. 4). Ссылка приходит до готовности окна (запуск exe по ссылке) или
 * в уже открытое приложение (`second-instance`, `open-url`). Сервис держит очередь, рендерер забирает её целиком по
 * сигналу или при старте — так ссылка не теряется ни до загрузки окна, ни при его перезагрузке.
 *
 * Ссылка несёт ключ хоста, поэтому в лог она не пишется.
 */

export const DEEP_LINK_SCHEME = 'projecthub';
const MAX_LINK_LENGTH = 4096;
const MAX_QUEUE = 8;

export function isDeepLink(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_LINK_LENGTH &&
    value.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`) &&
    !/\s/.test(value)
  );
}

/** Ссылка из аргументов процесса: Windows передаёт её отдельным аргументом после флагов Chromium. */
export function findDeepLink(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    if (isDeepLink(argv[i])) return argv[i];
  }
  return null;
}

class DeepLinkService {
  private queue: string[] = [];
  private notify: (() => void) | null = null;

  /** Сигнал рендереру «есть ссылки» и показ окна; задаёт main. */
  setNotifier(fn: () => void): void {
    this.notify = fn;
  }

  push(link: string): void {
    if (!isDeepLink(link)) return;
    this.queue.push(link);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.notify?.();
  }

  take(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

export const deepLinkService = new DeepLinkService();
