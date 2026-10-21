import React from 'react';
import { modules } from 'virtual:projecthub-edition/renderer';

/**
 * Точки расширения рендерера для модулей `ee/src/*` (TASK-151, decision-123 п. 4). Модуль экспортирует
 * `statusItems` (кнопки строки состояния), `overlays` (модалки, через `createPortal`, правило 19 infra-dev) и
 * `taskCardItems` (строки в карточке задачи). В открытой редакции модулей нет, и компоненты ниже ничего не рисуют.
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
}

const list = modules as EditionRendererModule[];
const statusItems = list.flatMap((m) => m.statusItems ?? []);
const overlays = list.flatMap((m) => m.overlays ?? []);
const taskCardItems = list.flatMap((m) => m.taskCardItems ?? []);
const taskBoardBadges = list.flatMap((m) => m.taskBoardBadges ?? []);

export const EditionStatusItems: React.FC = () => (
  <>
    {statusItems.map((Item, i) => (
      <Item key={i} />
    ))}
  </>
);

export const EditionOverlays: React.FC = () => (
  <>
    {overlays.map((Overlay, i) => (
      <Overlay key={i} />
    ))}
  </>
);

export const EditionTaskCardItems: React.FC<TaskCardItemProps> = (props) => (
  <>
    {taskCardItems.map((Item, i) => (
      <Item key={i} {...props} />
    ))}
  </>
);

export const EditionTaskBoardBadges: React.FC<TaskCardItemProps> = (props) => (
  <>
    {taskBoardBadges.map((Item, i) => (
      <Item key={i} {...props} />
    ))}
  </>
);
