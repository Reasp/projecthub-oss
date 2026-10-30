import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import tailwindcss from '@tailwindcss/vite';
import { createRequire } from 'node:module';
import { projecthubEdition } from './scripts/vite-edition.mjs';

// Все runtime-зависимости main-процесса остаются внешними (electron-builder кладёт node_modules в
// app.asar): нативные и тяжёлые пакеты (node-pty, @lancedb/lancedb, @huggingface/transformers,
// apache-arrow, zod, @modelcontextprotocol/sdk с его подпутями) не должны попадать в бандл —
// см. scripts/check-bundle.mjs (TASK-49, аудит 1.7).
const pkg = createRequire(import.meta.url)('./package.json') as { dependencies: Record<string, string> };
const runtimeDeps = Object.keys(pkg.dependencies);
const isExternalForMain = (id: string) =>
  id === 'electron' || runtimeDeps.some((dep) => id === dep || id.startsWith(`${dep}/`));

// main и preload пишут в общий dist-electron без очистки (у нескольких сборок vite-plugin-electron
// emptyOutDir выключен), и чанки прежних сборок копились там и уходили в app.asar. Каталог чистится
// до сборки, пока не запущена ни одна из них, и сразу получает воркеры: упакованное приложение ищет их
// только в dist-electron/workers (getWorkerScriptCandidates), а сборки без pack:win/pack:mac — `dist*` и
// open-edition.yml зеркала — их раньше не копировали (TASK-214).
const prepareDistElectron: Plugin = {
  name: 'projecthub-prepare-dist-electron',
  apply: 'build',
  config() {
    const out = path.resolve(import.meta.dirname, 'dist-electron');
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(path.resolve(import.meta.dirname, 'electron', 'workers'), path.join(out, 'workers'), { recursive: true });
  }
};

// Порт dev-сервера выдаёт ProjectHub в PORT (`portStrategy: 'auto'` в .projecthub.json): dev-серверы основного
// дерева и worktree работают одновременно (TASK-269). Electron и процессы проектов, которые он запускает, PORT не
// наследуют — иначе dev-сервер чужого проекта взял бы тот же порт.
const devServerPort = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : undefined;
delete process.env.PORT;

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  define: {
    'process.env': {}
  },
  plugins: [
    prepareDistElectron,
    projecthubEdition({ root: import.meta.dirname }),
    react(),
    tailwindcss(),
    electron([
      {
        // Main-Process entry file of the Electron App.
        entry: 'electron/main.ts',
        vite: {
          plugins: [projecthubEdition({ root: import.meta.dirname })],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: isExternalForMain
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            lib: {
              entry: 'electron/preload.ts',
              formats: ['cjs'],
              fileName: () => 'preload.cjs'
            },
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      }
    ])
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src')
    }
  },
  server: {
    port: devServerPort ?? 5173,
    // Порт выдан ProjectHub — занять именно его: соседний сервер мог зарезервировать следующий.
    strictPort: devServerPort !== undefined
  }
});
