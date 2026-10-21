import type { TtsPort } from './types';

/**
 * Озвучка голосового режима (TASK-179.2, [[decision-137]] п. 8). В приложении — нативный плагин `PhTts` (системный
 * TextToSpeech Android), в браузере и Telegram — `speechSynthesis`, если он есть.
 */

export interface TtsPlugin {
  isAvailable(): Promise<{ available: boolean; ready: boolean }>;
  speak(options: { text: string; lang: string }): Promise<void>;
  stop(): Promise<void>;
}

export function createNativeTts(plugin: TtsPlugin): TtsPort {
  return {
    available: () =>
      plugin
        .isAvailable()
        .then((r) => r.available)
        .catch(() => false),
    async speak(text, lang) {
      // Движок поднимается асинхронно при старте приложения: первая фраза может прийти раньше.
      for (let attempt = 0; ; attempt++) {
        try {
          await plugin.speak({ text, lang });
          return;
        } catch (err) {
          if (attempt < 10 && err instanceof Error && err.message === 'tts_not_ready') await new Promise((r) => setTimeout(r, 300));
          else throw err;
        }
      }
    },
    stop: () => void plugin.stop().catch(() => undefined)
  };
}

export function createWebTts(): TtsPort | undefined {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return undefined;
  return {
    available: async () => true,
    speak: (text, lang) =>
      new Promise<void>((resolve) => {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang === 'en' ? 'en-US' : 'ru-RU';
        u.onend = () => resolve();
        u.onerror = () => resolve();
        synth.speak(u);
      }),
    stop: () => synth.cancel()
  };
}
