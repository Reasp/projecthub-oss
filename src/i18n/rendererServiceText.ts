/**
 * Тексты сервисов рендерера вне React (TASK-202.13): голос, черновики коммита и PR, подписи по умолчанию. Свой
 * словарь en/ru, чтобы не тянуть общий; язык — язык окна из `<html lang>` (его ставит `useProjectStore`).
 */
import type { Language } from './types';

/** Язык окна для кода вне React: `useProjectStore` пишет его в `<html lang>`. До загрузки — английский. */
export function documentLanguage(): Language {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  return lang === 'ru' ? 'ru' : 'en';
}

const en = {
  voice: {
    microphone: (n: number) => `Microphone ${n}`,
    speakers: (n: number) => `Speakers / Headset ${n}`,
    headsetConnected: (label: string) => `Headset connected: “${label}”. Capture switched to it.`,
    deviceFallback: 'Audio device disconnected. Switched to the fallback microphone.',
    deviceSwitching: 'Audio device disconnected. Switching to the fallback microphone…',
    webSpeechError: (code: string) => `Web Speech API error: ${code}`,
    webSpeechUnavailable: 'Web Speech API is not available here. Select the Whisper engine in voice settings.',
    audioUnsupported: 'Audio recording devices are not supported here.',
    micStartFailed: 'Could not start the microphone.',
    micNotFound: 'Microphone not found. If you are connected remotely (RDP / AnyDesk / RustDesk), enable microphone redirection in the connection settings.',
    micDenied: 'Microphone access is blocked or denied by system permissions.',
    micBusy: 'The microphone is in use by another application, or the recording driver is unavailable.',
    micOverconstrained: 'The current microphone does not support these recording parameters.',
    whisperKeyMissing: (provider: string) => `The API key for ${provider} Whisper is not set. Enter it in voice settings.`
  },
  /** Черновики коммита и PR без модели: текст уходит в репозиторий человека на языке окна (decision-165 п. 14). */
  commitDraft: {
    docs: 'docs: update documentation and architecture decisions',
    tests: 'test: add unit tests',
    modules: (names: string) => `feat: update modules (${names})`,
    planned: 'feat: implement the planned changes',
    fallbackTitle: 'new changes',
    prSummary: 'Summary of changes',
    prDefaultDescription: (ref: string) => `This pull request implements the changes of ${ref}.`,
    prDone: 'What was done:',
    prDoneItems: ['Implemented the module logic', 'Checked compatibility with the existing architecture', 'Checked that the build passes without errors'],
    prRelated: 'Related tasks:'
  },
  initCommit: {
    update: 'chore: update the ProjectHub template',
    init: 'chore: initialize ProjectHub'
  },
  document: 'document',
  apiUnavailable: 'API is not available',
  studioProfile: 'Profile'
};

export type RendererServiceText = typeof en;

const ru: RendererServiceText = {
  voice: {
    microphone: (n) => `Микрофон ${n}`,
    speakers: (n) => `Динамики / наушники ${n}`,
    headsetConnected: (label) => `Гарнитура подключена: «${label}». Захват переключён на неё.`,
    deviceFallback: 'Аудиоустройство отключено. Выполнен переход на резервный микрофон.',
    deviceSwitching: 'Аудиоустройство отключено. Переключаюсь на резервный микрофон…',
    webSpeechError: (code) => `Ошибка Web Speech API: ${code}`,
    webSpeechUnavailable: 'Web Speech API здесь недоступен. Выберите движок Whisper в настройках голоса.',
    audioUnsupported: 'Аудиоустройства здесь не поддерживаются.',
    micStartFailed: 'Не удалось запустить микрофон.',
    micNotFound: 'Микрофон не обнаружен. Если вы подключены удалённо (RDP / AnyDesk / RustDesk), включите проброс микрофона в параметрах подключения.',
    micDenied: 'Доступ к микрофону заблокирован или запрещён разрешениями системы.',
    micBusy: 'Микрофон занят другим приложением или драйвер записи недоступен.',
    micOverconstrained: 'Текущий микрофон не поддерживает эти параметры записи.',
    whisperKeyMissing: (provider) => `Не задан API-ключ для ${provider} Whisper. Укажите его в настройках голоса.`
  },
  commitDraft: {
    docs: 'docs: обновление документации и архитектурных решений',
    tests: 'test: добавление модульных тестов',
    modules: (names) => `feat: обновление модулей (${names})`,
    planned: 'feat: реализация запланированных изменений',
    fallbackTitle: 'новые изменения',
    prSummary: 'Описание изменений',
    prDefaultDescription: (ref) => `В данном Pull Request реализованы изменения по задаче ${ref}.`,
    prDone: 'Что сделано:',
    prDoneItems: ['Реализована логика модуля', 'Проверена совместимость с существующей архитектурой', 'Протестирована сборка и отсутствие ошибок'],
    prRelated: 'Связанные задачи:'
  },
  initCommit: {
    update: 'chore: обновление шаблона ProjectHub',
    init: 'chore: инициализация ProjectHub'
  },
  document: 'документ',
  apiUnavailable: 'API недоступен',
  studioProfile: 'Профиль'
};

export const RENDERER_SERVICE_TEXT: Record<Language, RendererServiceText> = { en, ru };

export function rendererServiceText(language: Language = documentLanguage()): RendererServiceText {
  return RENDERER_SERVICE_TEXT[language] ?? en;
}
