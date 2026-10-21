/**
 * `backlog/` как хранилище Obsidian (TASK-178, decision-133): конфиг `.obsidian/`, плагин разрешения ссылок
 * `[[id]]`, регистрация хранилища в Obsidian и открытие по `obsidian://`.
 */
import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ObsidianOpenResult } from '../../src/types/electron';
import pluginMain from '../../resources/obsidian-plugin/main.js?raw';
import pluginManifest from '../../resources/obsidian-plugin/manifest.json?raw';
import {
  OBSIDIAN_PLUGIN_ID,
  addVaultToRegistry,
  findRegisteredVault,
  mergeCommunityPlugins,
  obsidianDefaultFiles,
  type ObsidianRegistry
} from './obsidianVaultConfig';

const execFileAsync = promisify(execFile);

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Создаёт недостающий конфиг `.obsidian/` и обновляет плагин. Настройки человека (`app.json`, `graph.json`)
 * не перезаписываются; из `community-plugins.json` чужие плагины не пропадают. Возвращает записанные пути.
 */
export async function ensureObsidianVault(vaultPath: string): Promise<string[]> {
  const configDir = path.join(vaultPath, '.obsidian');
  const written: string[] = [];
  const write = async (rel: string, content: string) => {
    const file = path.join(configDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    written.push(`.obsidian/${rel.split(path.sep).join('/')}`);
  };

  for (const [rel, content] of Object.entries(obsidianDefaultFiles())) {
    if (!existsSync(path.join(configDir, rel))) await write(rel, content);
  }

  const pluginsFile = 'community-plugins.json';
  const merged = mergeCommunityPlugins(await readText(path.join(configDir, pluginsFile)));
  if (merged.changed) await write(pluginsFile, merged.content);

  const pluginDir = path.join('plugins', OBSIDIAN_PLUGIN_ID);
  for (const [name, content] of [
    ['main.js', pluginMain],
    ['manifest.json', pluginManifest]
  ] as const) {
    const rel = path.join(pluginDir, name);
    if ((await readText(path.join(configDir, rel))) !== content) await write(rel, content);
  }
  return written;
}

/** Каталог настроек Obsidian, где лежит реестр хранилищ `obsidian.json`. */
function obsidianConfigDir(): string {
  return path.join(app.getPath('appData'), 'obsidian');
}

async function isObsidianRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { windowsHide: true });
      return /obsidian\.exe/i.test(stdout);
    }
    await execFileAsync('pgrep', ['-x', process.platform === 'darwin' ? 'Obsidian' : 'obsidian']);
    return true;
  } catch {
    // pgrep без совпадений завершается с кодом 1
    return false;
  }
}

/**
 * Готовит `backlog/` проекта и открывает его в Obsidian. Незарегистрированное хранилище дописывается в
 * `obsidian.json`, только пока Obsidian закрыт: запущенный Obsidian перезапишет файл своим состоянием.
 */
export async function openProjectInObsidian(projectPath: string): Promise<ObsidianOpenResult> {
  const vaultPath = path.join(path.normalize(projectPath), 'backlog');
  if (!existsSync(vaultPath)) return { status: 'no-backlog' };
  const written = await ensureObsidianVault(vaultPath);

  const configDir = obsidianConfigDir();
  if (!existsSync(configDir)) return { status: 'not-installed', vaultPath, written };

  const registryFile = path.join(configDir, 'obsidian.json');
  let registry: ObsidianRegistry = {};
  let registryReadable = true;
  const raw = await readText(registryFile);
  if (raw) {
    try {
      registry = JSON.parse(raw) as ObsidianRegistry;
    } catch {
      // нечитаемый реестр не трогаем: в нём могут быть чужие хранилища
      registryReadable = false;
    }
  }

  let registered = false;
  if (!findRegisteredVault(registry, vaultPath, process.platform)) {
    if (!registryReadable || (await isObsidianRunning())) {
      await shell.openExternal('obsidian://choose-vault');
      return { status: 'needs-manual', vaultPath, written };
    }
    const next = addVaultToRegistry(registry, vaultPath, randomBytes(8).toString('hex'), Date.now());
    await fs.writeFile(registryFile, JSON.stringify(next), 'utf8');
    registered = true;
  }

  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(vaultPath)}`);
  return { status: 'opened', vaultPath, written, registered };
}
