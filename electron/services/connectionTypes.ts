/**
 * Типы слоя подключений к внешним сервисам (TASK-138.1, decision-102). Без зависимостей от Electron:
 * модуль импортируют main-процесс и тесты, рендерер видит зеркало в `src/types/electron.d.ts`.
 */
import { AppError } from '../../src/lib/appError.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';

/** Способ входа (decision-102 п. 3). */
export type ConnectionAuthMethod = 'oauth-browser' | 'oauth-device' | 'token' | 'basic';

/** Состояние подключения: `needsReauth` — сервис отозвал доступ или refresh-токен больше не действует. */
export type ConnectionStatus = 'connected' | 'needsReauth' | 'error' | 'unchecked';

/** Категории интеграций, которым подходит сервис (TASK-138). */
export type ConnectionCategory = 'tracker' | 'vcs' | 'ci' | 'chat';

export interface ConnectionAccount {
  id?: string;
  login?: string;
  name?: string;
}

/** Запись подключения в `<userData>/connections.json`. Секретов здесь нет (decision-102 п. 1–2). */
export interface ConnectionRecord {
  id: string;
  serviceId: string;
  label: string;
  /** Базовый адрес веб-интерфейса сервиса (облако или self-hosted), без завершающего `/`. */
  baseUrl: string;
  method: ConnectionAuthMethod;
  scopes: string[];
  account?: ConnectionAccount;
  /** Имя пользователя для Basic — не секрет. */
  username?: string;
  /** `client_id` своего OAuth-приложения — публичный идентификатор. */
  oauthClientId?: string;
  /** Фиксированный порт возврата, если сервис требует точного адреса. */
  redirectPort?: number;
  status: ConnectionStatus;
  /** Код или текст последней ошибки — без значений секретов. */
  statusDetail?: string;
  /** Когда истекает токен доступа, мс. */
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
}

export interface ConnectionsFile {
  version: 1;
  connections: ConnectionRecord[];
}

/** Секреты подключения: одна запись `connection:<id>` в `secrets.enc.json`. */
export interface ConnectionSecret {
  /** Токен доступа, личный токен, API-ключ или пароль для Basic. */
  token: string;
  refreshToken?: string;
  /** `client_secret` своего OAuth-приложения. */
  clientSecret?: string;
}

/** Интеграция, которая использует подключение (decision-102 п. 7). */
export interface ConnectionUsage {
  connectionId: string;
  /** Что именно: «ClickUp → проект Demo», «PR GitHub». */
  label: string;
}

/** То, что видит рендерер: запись подключения без секретов и с признаками для окна. */
export interface ConnectionView extends ConnectionRecord {
  serviceLabel: string;
  hasRefreshToken: boolean;
  hasClientSecret: boolean;
  usedBy: string[];
}

/** Право (scope) для окна подключения (decision-102 п. 5). Пояснение берётся из i18n по `<сервис>:<право>`. */
export interface ConnectionScopeOption {
  id: string;
  default?: boolean;
}

/** Описание сервиса для окна: без функций каталога. */
export interface ConnectionServiceInfo {
  id: string;
  label: string;
  categories: ConnectionCategory[];
  methods: ConnectionAuthMethod[];
  defaultBaseUrl?: string;
  selfHosted: boolean;
  scopes: ConnectionScopeOption[];
  /** Для способа нужен `client_secret` своего приложения. */
  clientSecretRequired: Partial<Record<ConnectionAuthMethod, boolean>>;
  /** Встроенный `client_id` приложения ProjectHub, если он есть. */
  builtinClientId?: string;
  tokenHelpUrl?: string;
  oauthAppHelpUrl?: string;
  /** Подпись поля имени пользователя для Basic: «Почта» у Jira Cloud. */
  usernameHint?: string;
  /**
   * Подсказка к полю токена (TASK-138.6): `slackApp` — токен приложения `xapp-…` для Socket Mode, `webhook` — в поле
   * вставляется адрес вебхука целиком (Teams Workflows), он и есть секрет.
   */
  tokenHint?: 'slackApp' | 'webhook';
}

export type ConnectionFlowState = 'pending' | 'exchanging' | 'done' | 'error' | 'cancelled';

/** Ход входа через браузер или device flow — событие `connections:flowChanged`. */
export interface ConnectionFlowView {
  flowId: string;
  serviceId: string;
  method: 'oauth-browser' | 'oauth-device';
  state: ConnectionFlowState;
  /** Для device flow: код, который человек вводит на странице сервиса. Живёт минуты и не даёт доступа сам по себе. */
  userCode?: string;
  verificationUri?: string;
  /** Адрес страницы входа для браузерного входа — на случай, если браузер не открылся. */
  authorizeUrl?: string;
  expiresAt: number;
  connectionId?: string;
  error?: string;
}

/** Данные для нового подключения или переподключения из окна. */
export interface ConnectionInput {
  serviceId: string;
  method: ConnectionAuthMethod;
  label?: string;
  baseUrl?: string;
  scopes?: string[];
  /** token / basic */
  token?: string;
  username?: string;
  /** OAuth */
  clientId?: string;
  clientSecret?: string;
  redirectPort?: number;
}

/** Итог удаления: удалось ли отозвать токен у сервиса. */
export interface ConnectionRemoveResult {
  removed: boolean;
  remoteRevoke: 'revoked' | 'unsupported' | 'failed' | 'notNeeded';
  /** Где отозвать доступ вручную, если сервис не дал сделать это из приложения. */
  manualRevokeUrl?: string;
}

/** Ошибка авторизации для интеграций: подключение нужно переподключить. Текст — по коду (decision-165). */
export class ConnectionAuthError extends AppError {
  constructor(
    public readonly connectionId: string,
    code: AppErrorCode
  ) {
    super(code);
    this.name = 'ConnectionAuthError';
  }
}
