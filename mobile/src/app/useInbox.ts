import { useMemo, useSyncExternalStore } from 'react';
import { buildFeed, sourceFromSnapshot, type FeedSource, type InboxFeed } from '../protocol/inbox';
import { useAppState, useHostSummaries, useServices } from './context';
import { useT } from '../i18n/react';

/**
 * Лента «Входящих» со всех ПК телефона (TASK-140.5, decision-117 п. 7): открытый ПК — из стора (живая очередь HITL
 * и задачи агентов), остальные — последние снимки пула. `legacyActive` — открытый ПК старше ленты: у него нет
 * Review с отчётами и журнала, экран показывает прежнюю карточку задач в Review.
 */
export function useInboxFeed(filter: string | null = null): InboxFeed & { sources: FeedSource[]; legacyActive: boolean } {
  const { pool, profiles } = useServices();
  const hitl = useAppState((s) => s.hitl);
  const agentTasks = useAppState((s) => s.agentTasks);
  const inbox = useAppState((s) => s.inbox);
  const conn = useAppState((s) => s.conn);
  const status = useAppState((s) => s.status);
  const summaries = useHostSummaries();
  const inboxes = useSyncExternalStore(pool.subscribe, pool.getInboxes);
  // Словарь — зависимость ленты: имена ПК по умолчанию («Этот ПК», «ПК») меняются со сменой языка.
  const tr = useT();

  return useMemo(() => {
    const activeId = profiles.activeId;
    const activeProfile = profiles.profiles.find((p) => p.id === activeId);
    const sources: FeedSource[] = [];
    if (activeId) {
      sources.push({
        profileId: activeId,
        machineName: status?.machineName || activeProfile?.machineName || inbox?.machineName || tr.inbox.thisPc,
        online: conn.state === 'ready',
        active: true,
        ...(conn.rights ? { rights: conn.rights } : {}),
        hostReadOnly: conn.readOnly,
        hitl,
        agentTasks,
        review: inbox?.review ?? [],
        events: inbox?.events ?? []
      });
    }
    for (const p of profiles.profiles) {
      if (!p.id || p.id === activeId) continue;
      const snap = inboxes[p.id];
      const summary = summaries[p.id];
      if (!snap && !summary) continue;
      sources.push(
        sourceFromSnapshot(
          { profileId: p.id, machineName: p.machineName || snap?.machineName || '', online: summary?.state === 'ready', active: false, ...(p.rights ? { rights: p.rights } : {}) },
          snap
        )
      );
    }
    return { ...buildFeed(sources, filter), sources, legacyActive: Boolean(inbox?.legacy) };
  }, [profiles, hitl, agentTasks, inbox, conn.state, conn.rights, conn.readOnly, status, summaries, inboxes, filter, tr]);
}
