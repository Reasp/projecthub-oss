/**
 * Голосовой промпт с телефона (TASK-140.7, [[decision-121]] п. 4): приём PCM 16 бит 16 кГц частями по RPC `voice_chunk`
 * и распознавание тем же движком, что голос в окне. Без Electron — движки приходят зависимостями.
 */

export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_SECONDS = 90;
export const VOICE_MAX_BYTES = VOICE_SAMPLE_RATE * 2 * VOICE_MAX_SECONDS;
export const VOICE_CHUNK_BYTES = 384 * 1024;
/** Неоконченная запись живёт минуту: телефон мог потерять связь посреди отправки. */
const UPLOAD_TTL_MS = 60_000;

export type VoiceLanguage = 'ru' | 'en' | 'auto';

export interface VoiceChunk {
  id: string;
  index: number;
  total: number;
  data: Buffer;
  language: VoiceLanguage;
}

export function parseVoiceChunk(params: Record<string, unknown>): VoiceChunk {
  const id = typeof params.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(params.id) ? params.id : '';
  if (!id) throw new Error('id записи обязателен');
  const index = Number(params.index);
  const total = Number(params.total);
  if (!Number.isInteger(total) || total < 1 || total > Math.ceil(VOICE_MAX_BYTES / VOICE_CHUNK_BYTES)) throw new Error(`Запись длиннее ${VOICE_MAX_SECONDS} секунд`);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error('Неверный номер части');
  const data = Buffer.from(typeof params.data === 'string' ? params.data : '', 'base64');
  if (data.length === 0 || data.length > VOICE_CHUNK_BYTES || data.length % 2 !== 0) throw new Error('Неверная часть записи');
  const language = params.language === 'en' || params.language === 'auto' ? params.language : 'ru';
  return { id, index, total, data, language };
}

/** PCM 16 бит little-endian → float32 [-1, 1), как ждут Whisper и GigaAM. */
export function int16ToFloat32(pcm: Buffer): Float32Array {
  const out = new Float32Array(pcm.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

interface Upload {
  owner: string;
  parts: Map<number, Buffer>;
  total: number;
  bytes: number;
  language: VoiceLanguage;
  touched: number;
}

/** Сборка записи из частей: по владельцу (устройству), с пределом длины и временем жизни. */
export class VoiceUploads {
  private uploads = new Map<string, Upload>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Часть принята; когда пришли все — возвращает звук и язык, запись забывается. */
  put(owner: string, chunk: VoiceChunk): { done: false; received: number } | { done: true; samples: Float32Array; language: VoiceLanguage } {
    const now = this.now();
    for (const [id, u] of this.uploads) if (now - u.touched > UPLOAD_TTL_MS) this.uploads.delete(id);
    let upload = this.uploads.get(chunk.id);
    if (upload && upload.owner !== owner) throw new Error('Запись принадлежит другому устройству');
    if (!upload) {
      if ([...this.uploads.values()].filter((u) => u.owner === owner).length >= 3) throw new Error('Слишком много незаконченных записей');
      upload = { owner, parts: new Map(), total: chunk.total, bytes: 0, language: chunk.language, touched: now };
      this.uploads.set(chunk.id, upload);
    }
    if (upload.total !== chunk.total) throw new Error('Число частей записи изменилось');
    const prev = upload.parts.get(chunk.index);
    upload.bytes += chunk.data.length - (prev?.length ?? 0);
    if (upload.bytes > VOICE_MAX_BYTES) {
      this.uploads.delete(chunk.id);
      throw new Error(`Запись длиннее ${VOICE_MAX_SECONDS} секунд`);
    }
    upload.parts.set(chunk.index, chunk.data);
    upload.touched = now;
    if (upload.parts.size < upload.total) return { done: false, received: upload.parts.size };
    this.uploads.delete(chunk.id);
    const pcm = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
    return { done: true, samples: int16ToFloat32(pcm), language: upload.language };
  }

  dropOwner(owner: string): void {
    for (const [id, u] of this.uploads) if (u.owner === owner) this.uploads.delete(id);
  }
}

export interface VoiceEngines {
  /** GigaAM для русского, если модель установлена; `null` — нет. */
  sherpa(samples: Float32Array): Promise<{ text: string } | { noSpeech: true } | null>;
  whisper(samples: Float32Array, language: VoiceLanguage): Promise<{ text: string; language?: string }>;
  isHallucination(text: string): boolean;
}

export interface VoiceResult {
  text: string;
  engine: 'gigaam' | 'whisper' | 'none';
  language?: string;
}

/**
 * Тот же порядок, что голос в окне: для русского — GigaAM, если установлена, иначе Whisper; фраза-галлюцинация Whisper
 * («Продолжение следует», «Спасибо за просмотр») отбрасывается.
 */
export async function recognizeVoice(samples: Float32Array, language: VoiceLanguage, engines: VoiceEngines): Promise<VoiceResult> {
  if (samples.length < VOICE_SAMPLE_RATE / 4) return { text: '', engine: 'none' };
  if (language === 'ru') {
    const sherpa = await engines.sherpa(samples).catch(() => null);
    if (sherpa && 'noSpeech' in sherpa) return { text: '', engine: 'gigaam' };
    if (sherpa && sherpa.text.trim()) return { text: sherpa.text.trim(), engine: 'gigaam', language: 'ru' };
  }
  const res = await engines.whisper(samples, language);
  const text = (res.text || '').trim();
  if (!text || engines.isHallucination(text)) return { text: '', engine: 'whisper', ...(res.language ? { language: res.language } : {}) };
  return { text, engine: 'whisper', ...(res.language ? { language: res.language } : {}) };
}
