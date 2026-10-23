import type { AIToolCall } from './aiAgentService.js';
import type { ApiToolContext } from './apiToolExecutor.js';
import type { HitlRequest } from './hitlTypes.js';
import type { AppErrorKey } from '../../src/lib/appError.js';

/**
 * Адаптер чата Agents Studio для общего исполнителя API-инструментов (TASK-103, decision-47 п. 1). Переводит
 * события исполнителя в чанки чата прежнего формата и ставит статус проекта. Чистый модуль: канал
 * чанков и статус проекта внедряются, Electron не нужен.
 *
 * Объект вызова меняется на месте: итоговое сообщение `streamChat` собирает статусы из тех же объектов
 * (`loop.toolCalls`), поэтому статус, результат и дифф доживают до конца хода.
 */

/** Подмножество `ClaudeBridgeMessageChunk`, которое шлёт адаптер. */
export interface StudioToolChunk {
  toolCall?: AIToolCall;
  approvalRequest?: HitlRequest;
}

/**
 * Статус агента кодом (TASK-204, правило 25): текст собирает интерфейс из словарей, `detail` — команда или текст
 * ошибки. Ожидание решения отдельного кода не имеет: интерфейс берёт заголовок `pendingApproval`.
 */
export type AgentStatusCode = 'analyzing' | 'continuing' | 'processing' | 'executing' | 'approval_cancelled' | 'aborted' | 'completed' | 'failed';

export interface AgentStatusKey {
  code: AgentStatusCode;
  detail?: string;
  /** Код текста `detail` (decision-165): окно показывает причину на своём языке. */
  detailKey?: AppErrorKey;
}

export interface StudioToolAdapterDeps {
  emit(chunk: StudioToolChunk): void;
  /** Статус проекта Agents Studio (`claudeBridgeService.setProjectStatus`). */
  setStatus(status: 'running' | 'waiting_approval', message: string | AgentStatusKey, pendingApproval?: HitlRequest): void;
  /** У сессии остались другие ожидающие карточки. */
  hasPendingApprovals(): boolean;
  /** Сессия ещё идёт: после завершения статус проекта не трогаем. */
  isSessionActive(): boolean;
}

export type StudioToolCallbacks = Required<Pick<ApiToolContext, 'onApprovalRequest' | 'onApprovalSettled' | 'onToolUpdate'>>;

export const STUDIO_STATUS_PROCESSING: AgentStatusKey = { code: 'processing' };

function commandOf(call: AIToolCall): string {
  const args = call.args ?? {};
  const value = args.command ?? args.cmd;
  return typeof value === 'string' ? value : '';
}

export function createStudioToolCallbacks(deps: StudioToolAdapterDeps): StudioToolCallbacks {
  const backToRunning = () => {
    if (deps.isSessionActive() && !deps.hasPendingApprovals()) deps.setStatus('running', STUDIO_STATUS_PROCESSING);
  };
  return {
    onApprovalRequest(request, call) {
      if (call && request.type === 'file_write' && request.diff) {
        // Карточка записи приходит вместе с вызовом и диффом: по ним список шагов показывает «ждёт дифф».
        call.diff = request.diff;
        deps.emit({ approvalRequest: request, toolCall: { ...call } });
      } else {
        deps.emit({ approvalRequest: request });
      }
      deps.setStatus('waiting_approval', request.title, request);
    },
    onApprovalSettled() {
      backToRunning();
    },
    onToolUpdate(call, update) {
      call.status = update.status;
      if (update.result !== undefined) call.result = update.result;
      deps.emit({ toolCall: { ...call } });
      if (update.kind !== 'command') return;
      if (update.status === 'running') {
        // Статус ставится один раз на запуск, а не на каждый кусок вывода.
        if (update.result === undefined) deps.setStatus('running', { code: 'executing', detail: commandOf(call) });
      } else {
        backToRunning();
      }
    }
  };
}
