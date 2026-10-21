import { defineConfig } from 'vite';
import path from 'node:path';
import { createRequire } from 'node:module';
import { projecthubEdition } from './scripts/vite-edition.mjs';

/**
 * Сборка ph-agent (TASK-130, decision-119 п. 1): сервисы main-процесса на Node без Electron. Модуль `electron`
 * подменяется shim, чистые JS-зависимости кладутся в один файл — на целевой машине не нужен `npm install`.
 * Внешними остаются нативные и тяжёлые пакеты, которые сервисы грузят лениво.
 */
const pkg = createRequire(import.meta.url)('./package.json') as { version: string };
const LAZY_EXTERNAL = ['@lancedb/lancedb', '@huggingface/transformers', 'node-pty', 'apache-arrow', 'onnxruntime-node', 'sharp'];
const isExternal = (id: string) => id.startsWith('node:') || LAZY_EXTERNAL.some((dep) => id === dep || id.startsWith(`${dep}/`));

export default defineConfig({
  // Платные модули main-процесса (ee/electron, decision-123) входят и в ph-agent: это хост команды.
  plugins: [projecthubEdition({ root: import.meta.dirname })],
  define: {
    'process.env.PH_AGENT_VERSION': JSON.stringify(pkg.version)
  },
  resolve: {
    alias: {
      electron: path.resolve(import.meta.dirname, 'electron/headless/electronShim.ts')
    }
  },
  ssr: {
    noExternal: true,
    target: 'node'
  },
  build: {
    ssr: 'electron/headless/phAgent.ts',
    outDir: 'dist-ph-agent',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: isExternal,
      output: {
        format: 'es',
        entryFileNames: 'ph-agent.mjs',
        codeSplitting: false,
        banner: "import { createRequire as __phCreateRequire } from 'node:module'; const require = __phCreateRequire(import.meta.url);"
      }
    }
  }
});
