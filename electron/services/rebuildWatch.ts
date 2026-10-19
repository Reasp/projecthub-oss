/**
 * Сборку на диске заменили, а работает прежний процесс (decision-92, TASK-158).
 *
 * Закрытие окна сворачивает ProjectHub в трей; на macOS процесс остаётся в строке меню, и запуск
 * пересобранного `.app` с тем же `appId` система отдаёт старому процессу — человек видит старый
 * интерфейс. Старый процесс при показе окна сверяет свою отметку сборки с файлом на диске и один
 * раз предлагает перезапуститься. Без Electron: диалог и перезапуск передаёт main.ts.
 */
import { isBuildReplaced, type BuildInfo } from './buildInfo.js';

export interface RebuildWatchOptions {
  running: BuildInfo | null;
  readOnDisk: () => BuildInfo | null;
  /** Спросить человека; вызывается не больше одного раза за жизнь процесса. */
  prompt: (running: BuildInfo, onDisk: BuildInfo) => Promise<void>;
  /** Не чаще одной проверки за интервал: окно получает фокус часто. */
  minIntervalMs?: number;
  now?: () => number;
}

export class RebuildWatch {
  private prompted = false;
  private lastCheck = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RebuildWatchOptions) {}

  /** `true` — сборку заменили и человеку предложен перезапуск. */
  public async check(): Promise<boolean> {
    if (this.prompted || !this.options.running) return false;
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastCheck < (this.options.minIntervalMs ?? 15_000)) return false;
    this.lastCheck = now;
    const onDisk = this.options.readOnDisk();
    if (!onDisk || !isBuildReplaced(this.options.running, onDisk)) return false;
    this.prompted = true;
    await this.options.prompt(this.options.running, onDisk);
    return true;
  }
}
