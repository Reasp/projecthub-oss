import path from 'node:path';
import { existsSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';

interface WindowWatch {
  projectPath: string;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * Следит за задачами проекта, открытого в окне. У каждого окна свой проект (TASK-295: окна проектов), поэтому и
 * наблюдатель свой; «открытый проект» для Automations — проект главного окна, как до появления окон проектов.
 */
class BacklogWatcher {
  private watches = new Map<number, WindowWatch>();
  private primaryId: number | null = null;
  private projectListeners = new Set<(projectPath: string | null) => void>();

  /** Открытый проект главного окна. */
  currentProject(): string | null {
    return this.primaryId === null ? null : (this.watches.get(this.primaryId)?.projectPath ?? null);
  }

  /**
   * Смена открытого проекта — для источника событий задач Automations (TASK-74): встроенное правило
   * назначенных задач наблюдает открытый проект, как раньше наблюдал этот вотчер.
   */
  onProjectChange(listener: (projectPath: string | null) => void): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  private emitProjectChange(): void {
    const current = this.currentProject();
    for (const listener of this.projectListeners) listener(current);
  }

  /** `primary` — окно главное: его проект считается открытым для Automations. */
  watch(projectPath: string, win: BrowserWindow | null, primary = true) {
    if (!win || win.isDestroyed()) return;
    const id = win.webContents.id;
    if (primary) this.primaryId = id;
    const existing = this.watches.get(id);
    if (existing?.projectPath === projectPath) return;

    this.unwatchWindow(id, false);

    const tasksDir = path.join(projectPath, 'backlog', 'tasks');
    if (!existsSync(tasksDir)) {
      if (primary) this.emitProjectChange();
      return;
    }

    const watcher = chokidar.watch(tasksDir, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50
      }
    });
    const entry: WindowWatch = { projectPath, watcher, debounceTimer: null };
    this.watches.set(id, entry);
    if (!existing) win.once('closed', () => this.unwatchWindow(id, true));

    const notify = (event: string, filePath: string) => {
      if (win.isDestroyed()) return;
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        win.webContents.send('backlog:tasksChanged', {
          projectPath,
          event,
          filePath
        });
      }, 100);
    };

    watcher.on('add', (fp) => notify('add', fp));
    watcher.on('change', (fp) => notify('change', fp));
    watcher.on('unlink', (fp) => notify('unlink', fp));
    if (id === this.primaryId) this.emitProjectChange();
  }

  private unwatchWindow(id: number, emit: boolean): void {
    const entry = this.watches.get(id);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    void entry.watcher.close();
    this.watches.delete(id);
    if (emit && id === this.primaryId) {
      this.primaryId = null;
      this.emitProjectChange();
    }
  }

  unwatch() {
    const hadProject = this.currentProject() !== null;
    for (const id of [...this.watches.keys()]) this.unwatchWindow(id, false);
    if (hadProject) this.emitProjectChange();
  }
}

export const backlogWatcher = new BacklogWatcher();
