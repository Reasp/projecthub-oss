import type { AIProviderConfig, AISession, StudioRemoteRequestPayload } from '../types/electron';
import { STUDIO_READ_ONLY_ERROR, applyStudioSelection, canWriteStudioSession, parseStudioMode, parseStudioSelection } from '../utils/studioRemote';
import type { CreateSessionOptions, SendMessageOptions } from './useAIStudioStore';

/**
 * Запросы телефона к Agents Studio (TASK-140.10, decision-83). Хост не запускает агента сам, а передаёт промпт
 * окну: сессия идёт через тот же стор, что и вкладки на ПК, — сохраняется, видна вживую и продолжается с
 * обеих сторон. Модуль без React: стор внедряется, логика проверяется unit-тестами.
 */

/** Часть стора Agents Studio, которая нужна обработчику. */
export interface StudioStorePort {
  sessions: Record<string, AISession[]>;
  config: AIProviderConfig;
  /** sessionId -> идёт ответ (TASK-171). */
  streamingSessions: Record<string, true>;
  loadSessions(projectPath: string): Promise<void>;
  createSession(projectPath: string, initialTitle?: string, opts?: CreateSessionOptions): string;
  reopenSession(projectPath: string, session: AISession, activate?: boolean): void;
  sendMessage(projectPath: string, text: string, opts?: SendMessageOptions): Promise<void>;
  abortStream(sessionId: string): Promise<void>;
  clearSession(projectPath: string, sessionId?: string): void;
}

export interface StudioRemoteDeps {
  getState(): StudioStorePort;
  /** Сессии проекта на диске, включая историю (закрытые вкладки). */
  listFromDisk(projectPath: string): Promise<AISession[]>;
}

export interface StudioRemoteResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

/** Отказ, когда отвечает эта же сессия; другие вкладки проекта телефону не мешают (TASK-171). */
export function busyError(state: Pick<StudioStorePort, 'sessions'>, sessionId: string): string {
  const title = Object.values(state.sessions).flat().find((s) => s.id === sessionId)?.title;
  return `В сессии${title ? ` «${title}»` : ''} агент ещё отвечает. Дождитесь окончания или остановите ответ.`;
}

export async function handleStudioRemoteRequest(req: StudioRemoteRequestPayload, deps: StudioRemoteDeps): Promise<StudioRemoteResult> {
  const { projectPath } = req;
  if (!projectPath) return { ok: false, error: 'Проект не указан' };

  if (req.kind === 'abort') {
    const state = deps.getState();
    if (!req.sessionId || !state.streamingSessions[req.sessionId]) return { ok: false, error: 'В этой сессии агент сейчас не отвечает' };
    await state.abortStream(req.sessionId);
    return { ok: true, sessionId: req.sessionId };
  }

  if (req.kind === 'clear') {
    // /clear с телефона: та же очистка, что кнопкой на ПК — история и сессия Claude CLI сбрасываются.
    const state = deps.getState();
    if (req.sessionId && state.streamingSessions[req.sessionId]) return { ok: false, error: 'Агент ещё отвечает — сначала остановите ответ' };
    if (!(state.sessions[projectPath] || []).some((s) => s.id === req.sessionId)) return { ok: false, error: 'Очистить можно только сессию, открытую во вкладке на ПК' };
    state.clearSession(projectPath, req.sessionId);
    return { ok: true, sessionId: req.sessionId };
  }
  if (req.kind !== 'send') return { ok: false, error: 'Неизвестный запрос' };

  const text = typeof req.text === 'string' ? req.text.trim() : '';
  if (!text) return { ok: false, error: 'Пустой промпт' };

  await deps.getState().loadSessions(projectPath);

  let sessionId = req.sessionId;
  if (sessionId) {
    const open = (deps.getState().sessions[projectPath] || []).some((s) => s.id === sessionId);
    const known = (deps.getState().sessions[projectPath] || []).find((s) => s.id === sessionId);
    const fromDisk = known ? undefined : (await deps.listFromDisk(projectPath)).find((s) => s.id === sessionId);
    if (!known && !fromDisk) return { ok: false, error: 'Сессия не найдена на ПК — возможно, её удалили' };
    // Чужая сессия участника общего хоста — только для чтения (TASK-142.3); хост проверяет это и до окна.
    if (!canWriteStudioSession((known ?? fromDisk)!, req.memberId)) return { ok: false, error: STUDIO_READ_ONLY_ERROR };
    // Занята только сама сессия: ответы других вкладок идут параллельно (TASK-171).
    if (deps.getState().streamingSessions[sessionId]) return { ok: false, error: busyError(deps.getState(), sessionId) };
    if (!open && fromDisk) {
      // Сессия из истории: возвращаем её во вкладки, не переключая вкладку на ПК.
      deps.getState().reopenSession(projectPath, fromDisk, false);
    }
  } else {
    sessionId = deps.getState().createSession(projectPath, undefined, {
      activate: false,
      origin: 'phone',
      originDevice: typeof req.deviceName === 'string' ? req.deviceName.slice(0, 80) : undefined,
      ...(req.memberId ? { memberId: req.memberId } : {})
    });
  }

  const state = deps.getState();
  const config = applyStudioSelection(state.config, parseStudioSelection(req.selection));
  const mode = parseStudioMode(req.mode);
  // sendMessage ставит флаг стрима сессии синхронно, до первого await, — ждать весь ответ не нужно.
  void state.sendMessage(projectPath, text, { sessionId, config, ...(mode ? { mode } : {}), ...(req.memberId ? { memberId: req.memberId } : {}) });
  if (!deps.getState().streamingSessions[sessionId]) return { ok: false, error: 'Agents Studio не начала ответ' };
  return { ok: true, sessionId };
}
