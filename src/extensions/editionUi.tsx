import React, { useSyncExternalStore } from 'react';
import { modules } from 'virtual:projecthub-edition/renderer';

/**
 * Точки расширения рендерера для модулей `ee/src/*` (TASK-151, decision-123 п. 4). Модуль экспортирует
 * `statusItems` (кнопки строки состояния), `overlays` (модалки, через `createPortal`, правило 19 infra-dev),
 * `taskCardItems` (строки в карточке задачи) и `diagnosticsItems` (строки окна «Диагностика»). В открытой редакции
 * модулей нет, и компоненты ниже ничего не рисуют.
 *
 * Модуль с `gate: true` — пара шлюза main-процесса (TASK-200): он виден всегда, а остальные — только когда main
 * ответил, что модули редакции работают (`edition:info` → `active`). Пока ответа нет, видны только шлюзы.
 */
export interface TaskCardItemProps {
  projectPath: string;
  taskId: string;
  /** Модуль изменил задачу в файле: карточка обновляет черновик, чтобы «Сохранить» не затёр изменение. */
  onTaskChanged?: (fields: { status?: string; assignee?: string }) => void;
}

export interface EditionRendererModule {
  statusItems?: React.ComponentType[];
  overlays?: React.ComponentType[];
  taskCardItems?: React.ComponentType<TaskCardItemProps>[];
  /** Значки на карточке задачи на доске. */
  taskBoardBadges?: React.ComponentType<TaskCardItemProps>[];
  /** Строки окна «Диагностика». */
  diagnosticsItems?: React.ComponentType[];
  gate?: boolean;
}

type Slot = 'statusItems' | 'overlays' | 'taskCardItems' | 'taskBoardBadges' | 'diagnosticsItems';

const list = modules as EditionRendererModule[];
const gateModules = list.filter((m) => m.gate);

let active: boolean | null = list.length === gateModules.length ? true : null;
const listeners = new Set<() => void>();
if (active === null) {
  const settle = (value: boolean) => {
    active = value;
    for (const listener of listeners) listener();
  };
  const info = typeof window !== 'undefined' ? window.api?.getEditionInfo?.() : undefined;
  // Без ответа main — только шлюзы: модули, которых в main может не быть, не показываются.
  if (info) void info.then((v) => settle(v.active !== false), () => settle(false));
  else active = true;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function useSlot<T>(slot: Slot): T[] {
  const isActive = useSyncExternalStore(subscribe, () => active);
  return (isActive ? list : gateModules).flatMap((m) => (m[slot] ?? []) as T[]);
}

export const EditionStatusItems: React.FC = () => {
  const items = useSlot<React.ComponentType>('statusItems');
  return (
    <>
      {items.map((Item, i) => (
        <Item key={i} />
      ))}
    </>
  );
};

export const EditionOverlays: React.FC = () => {
  const overlays = useSlot<React.ComponentType>('overlays');
  return (
    <>
      {overlays.map((Overlay, i) => (
        <Overlay key={i} />
      ))}
    </>
  );
};

export const EditionTaskCardItems: React.FC<TaskCardItemProps> = (props) => {
  const items = useSlot<React.ComponentType<TaskCardItemProps>>('taskCardItems');
  return (
    <>
      {items.map((Item, i) => (
        <Item key={i} {...props} />
      ))}
    </>
  );
};

export const EditionTaskBoardBadges: React.FC<TaskCardItemProps> = (props) => {
  const items = useSlot<React.ComponentType<TaskCardItemProps>>('taskBoardBadges');
  return (
    <>
      {items.map((Item, i) => (
        <Item key={i} {...props} />
      ))}
    </>
  );
};

export const EditionDiagnosticsItems: React.FC = () => {
  const items = useSlot<React.ComponentType>('diagnosticsItems');
  return (
    <>
      {items.map((Item, i) => (
        <Item key={i} />
      ))}
    </>
  );
};
