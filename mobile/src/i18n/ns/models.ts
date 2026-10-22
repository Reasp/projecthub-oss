/** Раздел словаря «models» (TASK-140.15): тексты чистых моделей `protocol/models.ts` — права, ошибки, статусы агентов.
 * Подписи классов риска HITL — в разделе `inbox`. */
import { hitlRequestTextEn, hitlRequestTextRu } from '../../../../src/i18n/hitlRequestText';
import { appErrorTextEn, appErrorTextRu } from '../../../../src/i18n/appErrorText';

export const en = {
  rights: {
    hostReadOnly: 'Read only (host)',
    readOnly: 'Read only',
    hitl: 'Decisions only',
    full: 'Full access'
  },
  push: {
    noDistributor: 'No UnifiedPush distributor app. Install ntfy (works without Google services) and try again',
    timeout: 'The UnifiedPush distributor did not respond — open ntfy and check the server',
    failed: 'Could not enable notifications'
  },
  biometric: {
    lockout: 'Biometrics are locked after failed attempts — unlock the phone and try again, or approve on the computer',
    invalidated: 'The confirmation key is no longer valid (fingerprints or screen lock changed). Pair the phone with the computer again via QR',
    unavailable: 'Biometrics are not available on this phone — approve on the computer',
    failed: 'Could not confirm with biometrics — approve on the computer'
  },
  hitlDefaultTitle: 'The agent needs a decision',
  /** Заголовки и пояснения запросов по коду — общий словарь с окном ProjectHub (TASK-205). */
  hitlText: hitlRequestTextEn,
  /** Ошибки хоста по коду — общий словарь с окном и main (TASK-202, decision-165). */
  appErrors: appErrorTextEn,
  reject: {
    alreadyDecided: 'The request has already been decided',
    notFound: 'Request not found — it may have expired',
    confirmationRequired: 'This confirmation is not enough for this risk level: approve on the computer or with biometrics',
    hostRejected: 'The host rejected the decision',
    hostRejectedWith: (reason: string) => `The host rejected the decision: ${reason}`
  },
  agentStatus: {
    idle: 'Idle',
    pending: 'Queued',
    preparing: 'Preparing',
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
    interrupted: 'Interrupted',
    budget_exceeded: 'Budget exceeded'
  }
};

export const ru: typeof en = {
  rights: {
    hostReadOnly: 'Только чтение (хост)',
    readOnly: 'Только чтение',
    hitl: 'Только решения',
    full: 'Полный доступ'
  },
  push: {
    noDistributor: 'Нет приложения-дистрибьютора UnifiedPush. Установите ntfy (без сервисов Google) и повторите',
    timeout: 'Дистрибьютор UnifiedPush не ответил — откройте ntfy и проверьте сервер',
    failed: 'Не удалось включить уведомления'
  },
  biometric: {
    lockout: 'Биометрия заблокирована после неудачных попыток — разблокируйте телефон и повторите или одобрите на ПК',
    invalidated: 'Ключ подтверждения больше не действует (изменили отпечатки или блокировку экрана). Сопрягите телефон с ПК заново по QR',
    unavailable: 'Биометрия недоступна на этом телефоне — одобрите на ПК',
    failed: 'Не удалось подтвердить биометрией — одобрите на ПК'
  },
  hitlDefaultTitle: 'Агенту нужно решение',
  hitlText: hitlRequestTextRu,
  appErrors: appErrorTextRu,
  reject: {
    alreadyDecided: 'Запрос уже решён',
    notFound: 'Запрос не найден — возможно, истёк',
    confirmationRequired: 'Для такого риска этого подтверждения мало: одобрите на ПК или с биометрией',
    hostRejected: 'Хост отклонил решение',
    hostRejectedWith: (reason: string) => `Хост отклонил решение: ${reason}`
  },
  agentStatus: {
    idle: 'Ожидает',
    pending: 'В очереди',
    preparing: 'Подготовка',
    running: 'Работает',
    completed: 'Готово',
    failed: 'Ошибка',
    stopped: 'Остановлен',
    interrupted: 'Прерван',
    budget_exceeded: 'Превышен бюджет'
  }
};
