import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadOrCreateSecretKey, openSecret, sealSecret, type KeySource } from './headlessSecretKey.js';

/**
 * Модуль `electron` для ph-agent (TASK-130, [[decision-119]] п. 2): сборка `vite.ph-agent.config.ts` подставляет его
 * вместо Electron. Экспорты — договор «что сервисы хоста берут у Electron»: окон нет, человек не за этим ПК, сон не
 * запрещается, `safeStorage` — AES-256-GCM с ключом под защитой ОС. Пути читаются из окружения при вызове: ph-agent
 * задаёт их до загрузки сервисов.
 */

export function agentDataDir(): string {
  return process.env.PH_AGENT_DATA || path.join(os.homedir(), '.projecthub-agent');
}

export function agentHomeDir(): string {
  return process.env.PH_AGENT_HOME || os.homedir();
}

let secretKey: { key: Buffer; source: KeySource } | null = null;
function key(): Buffer {
  if (!secretKey) secretKey = loadOrCreateSecretKey(agentDataDir());
  return secretKey.key;
}

/** Откуда взят ключ секретов — для `ph-agent status`. Неверный ключ бросает `PhAgentError` — так его проверяют до загрузки сервисов. */
export function secretKeySource(): KeySource | null {
  key();
  return secretKey?.source ?? null;
}

const require = createRequire(import.meta.url);

function appVersion(): string {
  if (process.env.PH_AGENT_VERSION) return process.env.PH_AGENT_VERSION;
  try {
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const noop = () => undefined;

export const app = {
  // Как упакованное приложение: репозиторий разработки не добавляется в реестр проектов хоста.
  isPackaged: true,
  getPath(name: string): string {
    if (name === 'userData' || name === 'appData') return agentDataDir();
    if (name === 'home') return agentHomeDir();
    if (name === 'temp') return os.tmpdir();
    if (name === 'logs') return path.join(agentDataDir(), 'logs');
    return path.join(agentDataDir(), name);
  },
  setPath: noop,
  getAppPath(): string {
    return process.env.PH_AGENT_APP_ROOT || path.dirname(fileURLToPath(import.meta.url));
  },
  getVersion: appVersion,
  getName: () => 'ph-agent',
  on: noop,
  once: noop,
  whenReady: () => Promise.resolve(),
  quit: () => process.exit(0),
  exit: (code?: number) => process.exit(code ?? 0)
};

export const BrowserWindow = {
  getAllWindows: (): never[] => [],
  getFocusedWindow: (): null => null
};

/** Человек не за этим ПК: push на телефон не подавляется «окном в фокусе». */
export const powerMonitor = {
  getSystemIdleTime: () => Number.MAX_SAFE_INTEGER,
  on: noop
};

/** Серверы и VM не засыпают; запрет сна на ph-agent не держится (decision-119 п. 2). */
export const powerSaveBlocker = null;

/**
 * `requireEncryption` — метка для `secretStorageService` ([[decision-119]] п. 9): ключ задаёт владелец, его ошибка —
 * ошибка настройки, открытым текстом секреты не пишутся.
 */
export const safeStorage = {
  requireEncryption: true,
  isEncryptionAvailable: () => true,
  encryptString: (plain: string): Buffer => sealSecret(key(), plain),
  decryptString: (data: Buffer): string => openSecret(key(), data)
};

export const shell = {
  openExternal: async () => false,
  openPath: async () => 'No window',
  showItemInFolder: noop
};

export const globalShortcut = {
  register: () => false,
  unregister: noop,
  unregisterAll: noop,
  isRegistered: () => false
};

export const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getPrimaryDisplay: () => ({ size: { width: 0, height: 0 }, workAreaSize: { width: 0, height: 0 }, scaleFactor: 1 }),
  getAllDisplays: () => []
};

export class Notification {
  static isSupported(): boolean {
    return false;
  }
  show = noop;
  close = noop;
  on = noop;
}

/** Голосовой стек (GigaAM в utilityProcess) на ph-agent недоступен: голосовой промпт идёт на ПК с окном. */
export const utilityProcess = {
  fork: (): never => {
    throw new Error('utilityProcess is not available in ph-agent');
  }
};

export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const nativeTheme = { shouldUseDarkColors: true, on: noop };
export const crashReporter = { start: noop };

export default { app, BrowserWindow, powerMonitor, powerSaveBlocker, safeStorage, shell, globalShortcut, screen, Notification, utilityProcess, ipcMain, nativeTheme, crashReporter };
