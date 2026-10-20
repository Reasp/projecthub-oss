/**
 * Запрет сна хоста, пока он ждёт человека (TASK-140.5, [[decision-117]] п. 9, [[decision-79]] п. 9): ожидающий
 * запрос HITL или агент, запущенный с телефона, при включённом Remote Control с сопряжённым устройством. Electron
 * приходит зависимостью (`powerSaveBlocker`), решение — чистая функция.
 */

export interface KeepAwakeState {
  /** Выключатель в настройках Remote Control. */
  enabled: boolean;
  remoteEnabled: boolean;
  pairedDevices: number;
  pendingHitl: number;
  phoneAgents: number;
}

export function shouldKeepAwake(s: KeepAwakeState): boolean {
  if (!s.enabled || !s.remoteEnabled || s.pairedDevices === 0) return false;
  return s.pendingHitl > 0 || s.phoneAgents > 0;
}

export interface PowerBlocker {
  start(): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** Держит один блокировщик и снимает его, когда причина ушла. */
export class KeepAwakeController {
  private blockerId: number | null = null;

  constructor(
    private readonly blocker: PowerBlocker,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  get active(): boolean {
    return this.blockerId !== null && this.blocker.isStarted(this.blockerId);
  }

  apply(state: KeepAwakeState): boolean {
    const want = shouldKeepAwake(state);
    if (want && !this.active) {
      const id = this.blocker.start();
      this.blockerId = id >= 0 ? id : null;
      if (this.blockerId === null) return false;
      this.log(`[KeepAwake] ПК не уснёт: ждёт решения HITL (${state.pendingHitl}) или агент с телефона (${state.phoneAgents})`);
    } else if (!want && this.blockerId !== null) {
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
      this.blockerId = null;
      this.log('[KeepAwake] Запрет сна снят');
    }
    return this.active;
  }

  dispose(): void {
    if (this.blockerId !== null && this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
    this.blockerId = null;
  }
}
