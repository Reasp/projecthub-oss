import type { AIProviderConfig, StudioSessionAgent } from '../types/electron';
import { claudeEngineOf } from './connections';

/**
 * Движки вкладки Agents Studio (TASK-277, decision-220): кто ведёт разговор вкладки — Claude Code CLI или
 * API-провайдер через встроенный цикл инструментов. Здесь — id, возможности и правило выбора движка; main и окно
 * берут их отсюда, адаптеры движков живут в `electron/services/studioEngineRegistry.ts`.
 *
 * Чистый модуль без Electron и React: его импортируют main-процесс, окно и unit-тесты.
 */

/** Id движка вкладки. Новые CLI-агенты (Antigravity, opencode, Codex — TASK-278, TASK-279) добавляются сюда. */
export type StudioEngineId = 'claude-code' | 'api';

export const STUDIO_ENGINE_IDS: readonly StudioEngineId[] = ['claude-code', 'api'];

/** Что движок умеет во вкладке. По этим флагам окно показывает команды и меню, а не по имени движка. */
export interface StudioEngineCapabilities {
  /** Продолжение разговора по id сессии движка (`--resume`); без него движок получает всю историю вкладки. */
  resume: boolean;
  /** Карточки одобрения действий агента в Studio (HITL). */
  hitl: boolean;
  /** Откуда список моделей: свой список CLI или профили серверов моделей. */
  models: 'cli' | 'profiles';
  /** Выбор усилия рассуждений. */
  effort: boolean;
  /** Можно выключить рассуждения (усилие «none»). */
  effortNone: boolean;
  /**
   * Режим architect — план движка (plan mode: план до правок, утверждение — переход к работе). Без него architect —
   * ADR-режим API-пути: модель пишет решение, а не план.
   */
  plan: boolean;
  /** Ответвление разговора (`/fork`, `/btw`). */
  fork: boolean;
  /** Откат разговора с реплики (`/rewind`). */
  rewind: boolean;
  /** Дополнительные каталоги вкладки (`/add-dir`). */
  addDirs: boolean;
  /** Реплика во время хода уходит в идущий ход, а не ждёт его конца. */
  liveInput: boolean;
  /** Аккаунт движка выбирается во вкладке. */
  accounts: boolean;
}

export interface StudioEngineDescriptor {
  id: StudioEngineId;
  /** Имя в интерфейсе и в экспорте переписки — название продукта, не переводится. */
  label: string;
  /** Команда CLI, которую ищут в PATH; у API-пути её нет — движок доступен всегда. */
  command?: string;
  /** Движок запуска для политики HITL, аудита и ограничений (decision-124). */
  launchEngine: 'claude-cli' | 'api';
  capabilities: StudioEngineCapabilities;
}

export const STUDIO_ENGINES: Readonly<Record<StudioEngineId, StudioEngineDescriptor>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    launchEngine: 'claude-cli',
    capabilities: {
      resume: true,
      hitl: true,
      models: 'cli',
      effort: true,
      effortNone: false,
      plan: true,
      fork: true,
      rewind: true,
      addDirs: true,
      liveInput: true,
      accounts: true
    }
  },
  api: {
    id: 'api',
    label: 'API',
    launchEngine: 'api',
    capabilities: {
      resume: false,
      hitl: true,
      models: 'profiles',
      effort: true,
      effortNone: true,
      plan: false,
      fork: false,
      rewind: false,
      addDirs: false,
      liveInput: false,
      accounts: false
    }
  }
};

export function isStudioEngineId(value: unknown): value is StudioEngineId {
  return typeof value === 'string' && (STUDIO_ENGINE_IDS as readonly string[]).includes(value);
}

export function studioEngineCapabilities(engine: StudioEngineId): StudioEngineCapabilities {
  return STUDIO_ENGINES[engine].capabilities;
}

/**
 * Движок по конфигу запроса: Claude без API-ключа или с явным выбором подписки — Claude Code, остальное — API.
 * Правило подписки то же, что `mainEngineOf` в main (decision-74).
 */
export function studioEngineOfConfig(config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): StudioEngineId {
  return config.provider === 'anthropic' && claudeEngineOf(config) === 'claude-cli' ? 'claude-code' : 'api';
}

/**
 * Движок вкладки: свой у агента вкладки, а у вкладки без поля (до TASK-277) — по провайдеру вкладки и общему выбору
 * движка Claude, как было. Claude Code возможен только у провайдера `anthropic`: иначе поле считается ошибкой.
 */
export function studioEngineOfAgent(global: AIProviderConfig, agent: StudioSessionAgent | undefined): StudioEngineId {
  if (agent?.engine && (agent.engine !== 'claude-code' || agent.provider === 'anthropic')) return agent.engine;
  const provider = agent?.provider ?? global.provider;
  if (provider !== 'anthropic') return 'api';
  return claudeEngineOf(global) === 'claude-cli' ? 'claude-code' : 'api';
}

/** Поле `engine` конфига запроса для движка вкладки: так main и окно видят один и тот же движок. */
export function configEngineFor(engine: StudioEngineId): AIProviderConfig['engine'] {
  return engine === 'claude-code' ? 'claude-cli' : 'api';
}

/** Доступность движка на машине (`ai:studioEngines`): найден ли CLI и его версия. */
export interface StudioEngineStatus {
  id: StudioEngineId;
  available: boolean;
  version?: string;
}

/**
 * Показывать ли движок в выборе вкладки: только зарегистрированный и найденный. Пока проверка не пришла, CLI-движок
 * не показывается: иначе вкладку можно перевести на движок, которого нет. Движок без команды (API) доступен всегда.
 */
export function engineSelectable(engine: StudioEngineId, statuses: readonly StudioEngineStatus[] | null): boolean {
  if (!STUDIO_ENGINES[engine].command) return true;
  return !!statuses?.some((s) => s.id === engine && s.available);
}

/**
 * Группа моделей Claude в выборе вкладки. Она ведёт в Claude Code, только если вкладка выбрала бы этот движок: при
 * ключе Anthropic и движке API (общая настройка или свой движок вкладки) группа — Anthropic API, CLI ей не нужен.
 * `statuses === null` — проверка ещё идёт.
 */
export function claudeGroupState(
  global: AIProviderConfig,
  agent: StudioSessionAgent,
  statuses: readonly StudioEngineStatus[] | null
): 'available' | 'missing' | 'checking' {
  const engine = studioEngineOfAgent(global, {
    provider: 'anthropic',
    model: agent.model,
    ...(agent.provider === 'anthropic' && agent.engine ? { engine: agent.engine } : {})
  });
  if (engine !== 'claude-code') return 'available';
  if (!statuses) return 'checking';
  return engineSelectable('claude-code', statuses) ? 'available' : 'missing';
}
