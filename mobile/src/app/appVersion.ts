/**
 * Версия мобильного клиента (TASK-199): единая версия приложений из корневого `package.json` ([[decision-148]]),
 * подставляется при сборке `define` в `mobile/vite.config.ts`. Вне сборки (unit-тесты) — `dev`.
 */
declare const __PH_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __PH_VERSION__ === 'string' ? __PH_VERSION__ : 'dev';
