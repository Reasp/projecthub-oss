/**
 * Типы настройки индексации GitNexus для рендерера (TASK-176, decision-131).
 * Только type-импорт из main-процесса: в сборку рендерера код сервисов не попадает.
 */
export type { CodeIndexState } from '../../electron/services/codeIndexService';
export type {
  CodeIndexSettings,
  IndexContext,
  IndexGroup,
  IndexGroupKind,
  IndexProfile,
  IndexProfileId,
  Localized
} from '../../electron/services/codeIndexProfiles';
export type { IndexScanResult, IndexDirCount } from '../../electron/services/codeIndexScan';
