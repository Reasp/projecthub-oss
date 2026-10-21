/**
 * Голосовой промпт с телефона (TASK-140.7, [[decision-121]] п. 4): звук сводится в моно 16 кГц и уходит на ПК PCM
 * 16 бит частями `voice_chunk`. Распознаёт ПК — тем же движком, что голос в окне. Без браузерных API: запись — в
 * `platform/voiceRecorder.ts`.
 */

export const VOICE_RATE = 16_000;
export const VOICE_MAX_SECONDS = 90;
/** 384 КБ PCM на часть: в base64 ~512 КБ, как части вложений. */
export const VOICE_CHUNK_BYTES = 384 * 1024;

/** Сведение каналов в моно и пересчёт частоты линейной интерполяцией — для речи этого достаточно. */
export function downmixAndResample(channels: readonly Float32Array[], sampleRate: number, targetRate = VOICE_RATE): Float32Array {
  if (channels.length === 0 || channels[0].length === 0) return new Float32Array(0);
  const len = channels[0].length;
  const mono = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += (ch[i] ?? 0) / channels.length;
  if (sampleRate === targetRate) return mono;
  const outLen = Math.max(1, Math.floor((len * targetRate) / sampleRate));
  const out = new Float32Array(outLen);
  const step = sampleRate / targetRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(len - 1, i0 + 1);
    const t = pos - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return out;
}

/** Float32 [-1, 1] → PCM 16 бит little-endian. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface VoiceTranscript {
  text: string;
  engine: 'gigaam' | 'whisper' | 'none';
  language?: string;
}

export type VoiceRpc = (params: Record<string, unknown>) => Promise<{ received?: number } & Partial<VoiceTranscript>>;

/** Отправить запись частями; последний ответ — распознанный текст. Длиннее 90 секунд — обрезается. */
export async function sendVoice(
  rpc: VoiceRpc,
  samples: Float32Array,
  language: 'ru' | 'en' | 'auto',
  randomId: () => string = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
): Promise<VoiceTranscript> {
  const clipped = samples.length > VOICE_RATE * VOICE_MAX_SECONDS ? samples.subarray(0, VOICE_RATE * VOICE_MAX_SECONDS) : samples;
  const pcm = toPcm16(clipped);
  const total = Math.max(1, Math.ceil(pcm.length / VOICE_CHUNK_BYTES));
  const id = randomId();
  let last: Awaited<ReturnType<VoiceRpc>> = {};
  for (let index = 0; index < total; index++) {
    const part = pcm.subarray(index * VOICE_CHUNK_BYTES, (index + 1) * VOICE_CHUNK_BYTES);
    last = await rpc({ id, index, total, language, data: toBase64(part) });
  }
  return { text: last.text ?? '', engine: last.engine ?? 'none', ...(last.language ? { language: last.language } : {}) };
}

/** Распознанный текст в поле промпта: через пробел к уже написанному. */
export function appendTranscript(current: string, text: string): string {
  const t = text.trim();
  if (!t) return current;
  if (!current.trim()) return t;
  return /\s$/.test(current) ? `${current}${t}` : `${current} ${t}`;
}
