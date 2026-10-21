/**
 * Выделение фраз в постоянном слушании голосового режима (TASK-179.2, [[decision-137]] п. 1). Энергетический VAD:
 * порог — от уровня шума, начало фразы — после нескольких громких кадров подряд, конец — после паузы. Кадры до
 * начала держатся в предзаписи, чтобы не срезать первый слог. Чистый модуль без Web Audio.
 */

export interface VadOptions {
  sampleRate: number;
  /** Длина кадра в отсчётах. */
  frameSize: number;
  /** Сколько тишины закрывает фразу. */
  silenceMs: number;
  /** Сколько громких кадров подряд открывают фразу. */
  startMs: number;
  preRollMs: number;
  /** Фраза короче — щелчок или стук, а не речь. */
  minSpeechMs: number;
  /** Фраза длиннее режется: распознавание на ПК ждёт не больше 90 с, команды — короткие. */
  maxPhraseMs: number;
  /** Абсолютный нижний порог RMS: в тихой комнате шумовой порог не опускается до шороха. */
  minThreshold: number;
  /** Во сколько раз речь громче шума. */
  noiseRatio: number;
}

export const DEFAULT_VAD: Omit<VadOptions, 'sampleRate' | 'frameSize'> = {
  silenceMs: 900,
  startMs: 120,
  preRollMs: 350,
  minSpeechMs: 400,
  maxPhraseMs: 30_000,
  minThreshold: 0.012,
  noiseRatio: 3
};

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

export class VadSegmenter {
  private readonly o: VadOptions;
  private noise = 0;
  private loudRun = 0;
  private quietRun = 0;
  private speaking = false;
  private speechFrames = 0;
  private pre: Float32Array[] = [];
  private phrase: Float32Array[] = [];

  constructor(options: Pick<VadOptions, 'sampleRate' | 'frameSize'> & Partial<VadOptions>) {
    this.o = { ...DEFAULT_VAD, ...options };
  }

  private frames(ms: number): number {
    return Math.max(1, Math.round((ms / 1000) * (this.o.sampleRate / this.o.frameSize)));
  }

  /** Текущий порог речи. */
  threshold(): number {
    return Math.max(this.o.minThreshold, this.noise * this.o.noiseRatio);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Кадр звука. Возвращает фразу целиком, когда она закончилась. */
  push(frame: Float32Array): Float32Array | null {
    const level = rms(frame);
    const loud = level > this.threshold();
    if (!this.speaking) {
      // Шум оценивается только вне речи: медленно растёт, быстро падает.
      this.noise = this.noise === 0 ? level : level < this.noise ? this.noise * 0.9 + level * 0.1 : this.noise * 0.995 + level * 0.005;
      this.pre.push(frame);
      if (this.pre.length > this.frames(this.o.preRollMs)) this.pre.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= this.frames(this.o.startMs)) {
        this.speaking = true;
        this.phrase = this.pre;
        this.pre = [];
        this.speechFrames = this.loudRun;
        this.quietRun = 0;
      }
      return null;
    }
    this.phrase.push(frame);
    if (loud) {
      this.speechFrames++;
      this.quietRun = 0;
    } else this.quietRun++;
    const ended = this.quietRun >= this.frames(this.o.silenceMs);
    const tooLong = this.phrase.length >= this.frames(this.o.maxPhraseMs);
    if (!ended && !tooLong) return null;
    const out = this.speechFrames >= this.frames(this.o.minSpeechMs) ? concat(this.phrase) : null;
    this.reset();
    return out;
  }

  /** Сбросить начатую фразу: телефон заговорил сам или слушание поставлено на паузу. */
  reset(): void {
    this.speaking = false;
    this.loudRun = 0;
    this.quietRun = 0;
    this.speechFrames = 0;
    this.phrase = [];
    this.pre = [];
  }
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}
