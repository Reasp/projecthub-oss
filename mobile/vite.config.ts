import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Мобильный клиент ProjectHub (TASK-140.1, decision-79 п. 1): один React-код, две сборки.
 *
 * - `web` (по умолчанию) — встроенный клиент (`index.html`) и Telegram Mini App (`telegram.html`)
 *   с общими чанками. Раздаёт `remoteControlService`: страницы на `/remote` и `/telegram`,
 *   ассеты на `/m/…`. Входит в desktop-сборку (`npm run build` → `dist/mobile`).
 * - `capacitor` — интерфейс, собранный внутрь приложения iOS/Android (`mobile/dist/capacitor`).
 *   Пути относительные: WebView открывает его из пакета приложения, а не с ПК.
 *
 * Зависимости Electron и Node сюда не попадают: клиент импортирует из `src/` только
 * `types/remote.ts` и `utils/remoteCryptoWeb.ts`.
 */
const here = import.meta.dirname;
// Единая версия приложений (decision-148): та же, что у Android `versionName` и desktop, — из корневого package.json.
const version = (JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf-8')) as { version: string }).version;

export default defineConfig(({ mode }) => {
  const capacitor = mode === 'capacitor';
  const root = path.resolve(here, 'targets', capacitor ? 'capacitor' : 'web');
  return {
    root,
    base: capacitor ? './' : '/m/',
    publicDir: false,
    define: { __PH_VERSION__: JSON.stringify(version) },
    plugins: [react(), tailwindcss()],
    build: {
      // Веб-цель кладётся в `dist/mobile` рядом со сборкой рендерера: `dist/**` упаковывается в app.asar.
      outDir: capacitor ? path.resolve(here, 'dist', 'capacitor') : path.resolve(here, '..', 'dist', 'mobile'),
      emptyOutDir: true,
      target: ['es2022', 'safari15', 'chrome100'],
      sourcemap: false,
      rollupOptions: {
        input: capacitor
          ? { index: path.resolve(root, 'index.html') }
          : { index: path.resolve(root, 'index.html'), telegram: path.resolve(root, 'telegram.html') }
      }
    },
    server: {
      port: 5174,
      fs: { allow: [path.resolve(here, '..')] }
    }
  };
});
