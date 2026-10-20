import type { RemoteAgentTaskApproval, RemoteReviewItem, RemoteReviewResult, RemoteScreenshotChunk } from '../../../src/types/remote';
import { fetchScreenshot, type FeedSource } from '../protocol/inbox';
import { hitlRejectReason, type HitlItem } from '../protocol/models';
import type { RpcMethod } from '../protocol/remoteClient';
import type { AppStore } from './appStore';
import type { HostPool } from './hostPool';

/**
 * Действия «Входящих» над записью любого ПК телефона (TASK-140.5, [[decision-117]] п. 7). Открытый ПК — через
 * стор (его очередь HITL и биометрия), фоновый — его соединением из пула: решение уходит ровно тому ПК, с которого
 * пришла запись, с токеном его сопряжения. Без связи действие не отправляется.
 */

export type ReviewAction = 'done' | 'return';

type StorePort = Pick<AppStore, 'request' | 'decideHitl' | 'approveAgentTasks' | 'dismissInbox' | 'refreshInbox' | 'refreshTasks' | 'refreshSwarms' | 'showToast'>;
type PoolPort = Pick<HostPool, 'rpc' | 'refreshInbox'>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class InboxActions {
  constructor(
    private readonly store: StorePort,
    private readonly pool: PoolPort
  ) {}

  private rpc<T>(source: FeedSource, method: RpcMethod, params: Record<string, unknown>): Promise<T> {
    return source.active ? this.store.request<T>(method, params) : this.pool.rpc<T>(source.profileId, method, params);
  }

  private refresh(source: FeedSource): Promise<void> {
    return source.active ? this.store.refreshInbox() : this.pool.refreshInbox(source.profileId);
  }

  private offline(source: FeedSource): boolean {
    if (source.online) return false;
    this.store.showToast(`Нет связи с «${source.machineName}» — действие недоступно`, 'error');
    return true;
  }

  /** Решение HITL кнопкой в приложении; `high` с фонового ПК сюда не приходит — его одобряют, открыв этот ПК. */
  async decideHitl(source: FeedSource, item: HitlItem, approve: boolean): Promise<boolean> {
    if (this.offline(source)) return false;
    if (source.active) return this.store.decideHitl(item.requestId, approve);
    try {
      const res = await this.rpc<{ ok: boolean; reason?: string }>(source, 'hitl_decision', {
        requestId: item.requestId,
        sessionId: item.sessionId,
        decision: approve ? 'allow' : 'deny',
        confirm: 'app'
      });
      if (res?.ok === false) {
        this.store.showToast(hitlRejectReason(res.reason), 'error');
        return false;
      }
      this.store.showToast(`${approve ? 'Одобрено' : 'Отклонено'} на «${source.machineName}»`, 'success');
      return true;
    } catch (err) {
      this.store.showToast(errorText(err), 'error');
      return false;
    } finally {
      void this.refresh(source);
    }
  }

  async approveAgentTasks(source: FeedSource, projectPath: string, taskIds: string[]): Promise<boolean> {
    if (this.offline(source)) return false;
    if (source.active) return this.store.approveAgentTasks(projectPath, taskIds);
    try {
      const res = await this.rpc<RemoteAgentTaskApproval>(source, 'approve_agent_tasks', { projectPath, taskIds });
      this.store.showToast(res.approved.length > 0 ? `Подтверждено задач: ${res.approved.length}` : 'Задачи уже подтверждены', res.approved.length > 0 ? 'success' : 'info');
      return res.approved.length > 0;
    } catch (err) {
      this.store.showToast(errorText(err), 'error');
      return false;
    } finally {
      void this.refresh(source);
    }
  }

  async dismiss(source: FeedSource, ids: string[]): Promise<boolean> {
    if (ids.length === 0 || this.offline(source)) return false;
    if (source.active) return this.store.dismissInbox(ids);
    try {
      await this.rpc(source, 'inbox_dismiss', { ids });
      return true;
    } catch (err) {
      this.store.showToast(errorText(err), 'error');
      return false;
    } finally {
      void this.refresh(source);
    }
  }

  /** Принять задачу или вернуть агенту с комментарием (decision-117 п. 4). */
  async review(source: FeedSource, item: RemoteReviewItem, action: ReviewAction, comment: string, restart: boolean): Promise<boolean> {
    if (this.offline(source)) return false;
    try {
      const res = await this.rpc<RemoteReviewResult>(source, 'review_task', {
        action,
        projectPath: item.projectPath,
        taskId: item.id,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(action === 'return' && restart ? { restart: true } : {})
      });
      const text =
        action === 'done' ? `${item.id} принята — Done` : res.swarmId ? `${item.id} возвращена, агент перезапущен` : `${item.id} возвращена в работу`;
      this.store.showToast(text, 'success');
      if (source.active) {
        void this.store.refreshTasks();
        if (res.swarmId) void this.store.refreshSwarms();
      }
      return true;
    } catch (err) {
      this.store.showToast(errorText(err), 'error');
      return false;
    } finally {
      void this.refresh(source);
    }
  }

  /** Скриншот отчёта как data URL; `null` — не загрузился (тост уже показан). */
  async screenshot(source: FeedSource, item: RemoteReviewItem, relPath: string): Promise<string | null> {
    if (!source.online) return null;
    try {
      return await fetchScreenshot((params) => this.rpc<RemoteScreenshotChunk>(source, 'get_review_screenshot', params), {
        projectPath: item.projectPath,
        taskId: item.id,
        relPath
      });
    } catch (err) {
      this.store.showToast(`Скриншот не загружен: ${errorText(err)}`, 'error');
      return null;
    }
  }
}
