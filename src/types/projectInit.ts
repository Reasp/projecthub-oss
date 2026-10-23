/**
 * Типы инициализации проекта и каталога шаблонов для рендерера (TASK-136, decision-78).
 * Только type-импорт из main-процесса: в сборку рендерера код сервисов не попадает.
 */
export type {
  InitRequest,
  InitApplyRequest,
  InitPreview,
  InitReport,
  InitProgressEvent,
  InitTemplateView,
  InitOptionView,
  TemplateUpdateStatus
} from '../../electron/services/projectInitService';
export type { InitAction, InitPlanItem, InitReason, InitGroup, FoundationPart, RulesMode } from '../../electron/services/initFoundation';
export type { TemplateEntry, TemplateOrigin } from '../../electron/services/templateCatalog';
export type { TemplateRisks, Placement } from '../../electron/services/initTemplateLayer';
export type { SaveTemplatePreview, SaveTemplateFile } from '../../electron/services/templateSaveService';

/** Ошибка — английский текст и код для текста на языке окна (decision-165, `appFailureText`). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string; errorKey?: import('../lib/appError').AppErrorKey };
