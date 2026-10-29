import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import https from 'node:https';
// electron-updater — CommonJS-пакет; его именованный экспорт не синтезируется корректно под Node
// ESM-загрузчиком main-процесса ("SyntaxError: Named export 'autoUpdater' not found"), поэтому
// берём default-экспорт и деструктурируем вручную (обнаружено запуском `npm run dev` вживую).
import electronUpdaterPkg from 'electron-updater';
import { logger } from './logger.js';
import { getNetworkPolicy } from './networkGuard.js';
import { AppError, appErrorKeyOf, type AppErrorKey } from '../../src/lib/appError.js';
import { isNewerVersion } from './versionCompare.js';
import { resolveUpdateFeed, updateSource, versionFromLatestYml, type GenericFeed } from './updateFeed.js';
import { buildEdition } from '../extensions/loadEditionModules.js';
import productLinks from '../../src/lib/productLinks.json';
import updateChannel from '../../src/lib/updateChannel.json';

const { autoUpdater } = electronUpdaterPkg;

export { isNewerVersion };

/**
 * Проверка обновлений (TASK-58, decision-14 п.2): `electron-updater` + GitHub Releases для
 * Windows/Linux (авто-скачивание и установка при выходе), для macOS без подписи — только сверка
 * версии через GitHub API и ссылка на страницу релиза (Squirrel.Mac требует codesign, которого
 * пока нет). Проверка запускается один раз при старте (с задержкой) и по кнопке из «Диагностики».
 *
 * Канал `generic` на домене сайта (TASK-144.4, decision-172) включается флагом или `PROJECTHUB_UPDATE_FEED_URL`
 * (`updateFeed.ts`); без них — GitHub Releases публичного зеркала, как раньше.
 */

// Релизы открытой редакции — в публичном зеркале (decision-158 п. 4), источник приватный.
const GITHUB_OWNER = 'Reasp';
const GITHUB_REPO = 'projecthub-oss';

export type UpdaterState = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface UpdaterStatus {
  state: UpdaterState;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  releaseUrl?: string;
  error?: string;
  /** Код ошибки (decision-165): окно показывает её на своём языке. */
  errorKey?: AppErrorKey;
  /** false на macOS без подписи: там доступна только ссылка на релиз, не авто-установка. */
  supportsAutoInstall: boolean;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

class UpdaterService {
  private configured = false;
  private readonly feedInput = {
    edition: buildEdition,
    siteUrl: productLinks.site,
    genericEnabled: updateChannel.genericEnabled,
    override: process.env.PROJECTHUB_UPDATE_FEED_URL
  };
  private readonly feed: GenericFeed | null = resolveUpdateFeed(this.feedInput);
  private readonly source = updateSource(this.feedInput);
  private status: UpdaterStatus = {
    state: 'idle',
    currentVersion: app.isPackaged ? app.getVersion() : '0.0.0-dev',
    supportsAutoInstall: process.platform !== 'darwin'
  };

  getStatus(): UpdaterStatus {
    return this.status;
  }

  private setError(err: unknown): void {
    this.setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err), errorKey: appErrorKeyOf(err) });
  }

  private setStatus(patch: Partial<UpdaterStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('updater:statusChanged', this.status);
    }
  }

  private configure(): void {
    if (this.configured) return;
    this.configured = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    if (this.feed) {
      logger.info(`[Updater] Канал обновлений: ${this.feed.url}`);
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feed.url });
    }

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking', error: undefined, errorKey: undefined }));
    autoUpdater.on('update-available', (info) => {
      this.setStatus({ state: 'available', latestVersion: info.version });
      autoUpdater.downloadUpdate().catch((err) => {
        this.setError(err);
      });
    });
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) => this.setStatus({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.setStatus({ state: 'downloaded', latestVersion: info.version }));
    autoUpdater.on('error', (err) => {
      logger.warn(`[Updater] ${err?.message || err}`);
      this.setError(err);
    });
  }

  public async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      logger.info('[Updater] Пропущено: dev-сборка не упакована');
      this.setStatus({ state: 'not-available' });
      return;
    }

    // Закрытый контур (decision-186 п. 3, 6): релизы в интернете недоступны, обновление приходит файлом от администратора.
    if (getNetworkPolicy().airGapped) {
      logger.info('[Updater] Skipped: air-gapped mode, updates are delivered as a file');
      this.setError(new AppError('updater.airGapped'));
      return;
    }

    // Полная сборка без канала Team: релизы зеркала — открытая редакция, обновление через них сняло бы модули ee/.
    if (this.source === 'none') {
      logger.info('[Updater] Полная сборка: обновления — по ссылке заказчика, релизы зеркала не используются');
      this.setError(new AppError('updater.teamManual'));
      return;
    }

    if (process.platform === 'darwin') {
      await this.checkGithubReleaseManually();
      return;
    }

    this.configure();
    try {
      this.setStatus({ state: 'checking', error: undefined, errorKey: undefined });
      await autoUpdater.checkForUpdates();
    } catch (err: any) {
      this.setError(err);
    }
  }

  private async checkGithubReleaseManually(): Promise<void> {
    this.setStatus({ state: 'checking', error: undefined, errorKey: undefined });
    try {
      let latest: string | null | undefined;
      let releaseUrl: string;
      if (this.feed) {
        // Канал сайта: версия из latest-mac.yml, ссылка — на релиз зеркала с этой версией.
        latest = versionFromLatestYml(await this.fetchText(`${this.feed.url}latest-mac.yml`));
        releaseUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${latest ?? ''}`;
      } else {
        const release = JSON.parse(await this.fetchText(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`)) as GithubRelease;
        latest = release.tag_name?.replace(/^v/, '');
        releaseUrl = release.html_url;
      }
      if (latest && isNewerVersion(latest, this.status.currentVersion)) {
        this.setStatus({ state: 'available', latestVersion: latest, releaseUrl });
      } else {
        this.setStatus({ state: 'not-available' });
      }
    } catch (err: any) {
      this.setError(err);
    }
  }

  private fetchText(url: string, redirects = 3): Promise<string> {
    const github = url.startsWith('https://api.github.com/');
    return new Promise((resolve, reject) => {
      const get = url.startsWith('http://') ? http.get : https.get;
      const req = get(url, { headers: { 'User-Agent': 'ProjectHub-Updater' } }, (res) => {
        // Хостинг сайта может перенаправлять (apex → www, слэш в конце): идём следом, как electron-updater на Windows.
        const location = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location && redirects > 0) {
          res.resume();
          this.fetchText(new URL(location, url).toString(), redirects - 1).then(resolve, reject);
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new AppError(github ? 'updater.githubStatus' : 'updater.feedStatus', { status: String(res.statusCode) }));
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new AppError(github ? 'updater.githubTimeout' : 'updater.feedTimeout')));
    });
  }

  /** Установка скачанного обновления при выходе (Windows/Linux) — доступно только после `downloaded`. */
  public installNow(): void {
    if (this.status.state !== 'downloaded') return;
    autoUpdater.quitAndInstall();
  }
}

export const updaterService = new UpdaterService();
