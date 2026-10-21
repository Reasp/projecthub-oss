import React from 'react';
import { modules } from 'virtual:projecthub-edition/renderer';

/**
 * Точки расширения рендерера для модулей `ee/src/*` (TASK-151, decision-123 п. 4). Модуль экспортирует
 * `statusItems` (кнопки строки состояния) и `overlays` (модалки, через `createPortal`, правило 19 infra-dev).
 * В открытой редакции модулей нет, и компоненты ниже ничего не рисуют.
 */
export interface EditionRendererModule {
  statusItems?: React.ComponentType[];
  overlays?: React.ComponentType[];
}

const list = modules as EditionRendererModule[];
const statusItems = list.flatMap((m) => m.statusItems ?? []);
const overlays = list.flatMap((m) => m.overlays ?? []);

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
