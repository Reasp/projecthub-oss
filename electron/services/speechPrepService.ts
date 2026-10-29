/**
 * Подготовка звука фразы перед распознаванием (TASK-164.2, decision-94): шумодав и Silero VAD в
 * отдельном `utilityProcess` (`electron/workers/speechWorker.mjs`) — по образцу синтеза Piper
 * (decision-34): у sherpa своя `onnxruntime.dll`, в процесс с Whisper её грузить нельзя.
 *
 * Сервис намеренно не бросает исключений наружу: любая неудача — процесс не стартовал, упал, модель
 * не найдена, таймаут — даёт `{ ok: false }`, и рендерер распознаёт фразу как раньше, без шлюза.
 * Голосовое управление не должно ломаться из-за необязательной обработки звука.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { getBundledVoiceModelsDir, getWorkerScriptCandidates } from './appPaths';
import type { InstalledAsrModel } from './asrModelStore';

export type NoiseReduction = 'off' | 'gtcrn' | 'dpdfnet';

export interface SpeechPrepRequest {
  /** Фраза целиком, моно 16 кГц. */
  samples: Float32Array;
  /** Отсекать фразы без речи и обрезать тишину по краям (Silero VAD). */
  gate: boolean;
  denoise: NoiseReduction;
}

export type SpeechPrepResult =
  | { ok: true; speech: false; vadMs: number; denoiseMs: number }
  | { ok: true; speech: true; samples: Float32Array; speechSec: number; vadMs: number; denoiseMs: number }
  | { ok: false; error: string };

/** Подготовка и распознавание локальной моделью sherpa одним вызовом (TASK-164.4). */
export type SpeechRecognizeResult =
  | { ok: true; speech: false; vadMs: number; denoiseMs: number }
  | { ok: true; speech: true; text: string; speechSec: number; vadMs: number; denoiseMs: number; asrMs: number }
  | { ok: false; error: string };

/** Ответ процесса без разбора: поля зависят от типа запроса. */
type WorkerReply = { ok: true; msg: Record<string, unknown> } | { ok: false; error: string };

export interface SpeechPrepState {
  status: 'idle' | 'ready' | 'unavailable';
  workerActive: boolean;
  /** Какие модели нашлись в сборке. */
  models: { vad: boolean; gtcrn: boolean; dpdfnet: boolean };
  respawnAttempts: number;
  error?: string;
}

/** Фраза до минуты (предел push-to-talk): шумодав и VAD укладываются в доли секунды, запас — на холодный старт. */
export const PREPARE_TIMEOUT_MS = 15_000;
/**
 * Распознавание: холодная загрузка GigaAM с медленного диска и фраза с телефона до 90 с (`VOICE_MAX_SECONDS`).
 * Тайм-аут убивает процесс вместе с загруженной моделью, поэтому он с большим запасом (TASK-231.3).
 */
export const RECOGNIZE_TIMEOUT_MS = 180_000;
const MAX_RESPAWN_ATTEMPTS = 2;

const MODEL_FILES = {
  vad: 'silero_vad.onnx',
  gtcrn: 'gtcrn_simple.onnx',
  dpdfnet: 'dpdfnet2.onnx'
} as const;

interface Pending {
  resolve: (reply: WorkerReply) => void;
  timer: NodeJS.Timeout;
}

export class SpeechPrepService {
  private worker: UtilityProcess | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private respawnAttempts = 0;
  private unavailableReason: string | null = null;
  private lastError?: string;
  private disposed = false;

  /** Пути к найденным моделям; отсутствующая модель — undefined, её шаг пропускается. */
  private modelPaths(): Partial<Record<keyof typeof MODEL_FILES, string>> {
    const dir = getBundledVoiceModelsDir();
    if (!dir) return {};
    const paths: Partial<Record<keyof typeof MODEL_FILES, string>> = {};
    for (const [key, file] of Object.entries(MODEL_FILES) as Array<[keyof typeof MODEL_FILES, string]>) {
      const full = path.join(dir, file);
      if (existsSync(full)) paths[key] = full;
    }
    return paths;
  }

  getState(): SpeechPrepState {
    const models = this.modelPaths();
    return {
      status: this.unavailableReason ? 'unavailable' : this.worker ? 'ready' : 'idle',
      workerActive: Boolean(this.worker),
      models: { vad: Boolean(models.vad), gtcrn: Boolean(models.gtcrn), dpdfnet: Boolean(models.dpdfnet) },
      respawnAttempts: this.respawnAttempts,
      error: this.unavailableReason ?? this.lastError
    };
  }

  private ensureWorker(): UtilityProcess | null {
    if (this.disposed || this.unavailableReason) return null;
    if (this.worker) return this.worker;

    const workerPath = getWorkerScriptCandidates('speechWorker.mjs').find((p) => existsSync(p));
    if (!workerPath) {
      this.unavailableReason = 'speechWorker.mjs not found next to the app bundle';
      console.warn(`[SpeechPrep] Unavailable: ${this.unavailableReason}`);
      return null;
    }

    try {
      const worker = utilityProcess.fork(workerPath, [], { serviceName: 'ProjectHub Speech Prep', stdio: 'pipe' });
      worker.on('message', (msg: unknown) => this.handleMessage(worker, msg));
      worker.on('exit', (code) => this.handleExit(worker, code));
      worker.stdout?.on('data', (data: Buffer) => console.log(`[SpeechPrep:process] ${data.toString().trim()}`));
      worker.stderr?.on('data', (data: Buffer) => console.warn(`[SpeechPrep:process] ${data.toString().trim()}`));
      this.worker = worker;
      console.log('[SpeechPrep] Utility process started');
      return worker;
    } catch (err) {
      this.unavailableReason = err instanceof Error ? err.message : String(err);
      console.warn(`[SpeechPrep] Unavailable: ${this.unavailableReason}`);
      return null;
    }
  }

  private handleMessage(worker: UtilityProcess, raw: unknown) {
    if (this.worker !== worker || !raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    if (msg.type === 'ready') return;
    const id = msg.id as string | undefined;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (msg.type === 'error') {
      this.lastError = String(msg.error);
      pending.resolve({ ok: false, error: this.lastError });
      return;
    }
    // Процесс ответил — разрешаем будущие перезапуски заново
    this.respawnAttempts = 0;
    pending.resolve({ ok: true, msg });
  }

  private handleExit(worker: UtilityProcess, code: number) {
    if (this.worker !== worker) return;
    this.dropWorker(`Speech prep process exited with code ${code}`);
  }

  /**
   * Процесс больше не годится (вышел или завис): ожидающие запросы получают отказ, сбой считается к пределу
   * перезапусков, следующая фраза поднимет новый процесс.
   */
  private dropWorker(error: string) {
    this.worker = null;
    this.lastError = error;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ ok: false, error });
    }
    if (this.disposed) return;
    this.respawnAttempts += 1;
    if (this.respawnAttempts > MAX_RESPAWN_ATTEMPTS) {
      this.unavailableReason = error;
      console.warn(`[SpeechPrep] Unavailable after ${MAX_RESPAWN_ATTEMPTS} restarts: ${error}`);
    } else {
      console.warn(`[SpeechPrep] ${error}; will respawn on next phrase (${this.respawnAttempts}/${MAX_RESPAWN_ATTEMPTS})`);
    }
  }

  private send(payload: Record<string, unknown>, timeoutMs = PREPARE_TIMEOUT_MS): Promise<WorkerReply> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve({ ok: false, error: this.unavailableReason || 'speech prep is unavailable' });

    const id = `prep-${++this.counter}`;
    return new Promise<WorkerReply>((resolve) => {
      const timer = setTimeout(() => {
        // Процесс обрабатывает запросы по очереди: завис он только если не ответил на самый старый из ожидающих.
        // Более поздний запрос, простоявший в очереди за долгим распознаванием, просто получает отказ.
        const hung = this.pending.keys().next().value === id;
        this.pending.delete(id);
        const error = `speech prep timed out after ${timeoutMs / 1000}s`;
        resolve({ ok: false, error });
        // Зависший процесс не отвечает и следующим фразам (TASK-231.3): убиваем его, следующая фраза поднимет новый.
        if (hung && this.worker === worker) {
          this.dropWorker(error);
          try {
            worker.kill();
          } catch {
            // уже завершился
          }
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      try {
        worker.postMessage({ ...payload, id });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async prepare(req: SpeechPrepRequest): Promise<SpeechPrepResult> {
    const models = this.modelPaths();
    if (req.gate && !models.vad && (req.denoise === 'off' || !models[req.denoise])) {
      return { ok: false, error: 'voice models not found' };
    }
    const reply = await this.send({ type: 'prepare', samples: req.samples, gate: req.gate, denoise: req.denoise, models });
    if (!reply.ok) return reply;
    const { msg } = reply;
    const vadMs = Number(msg.vadMs) || 0;
    const denoiseMs = Number(msg.denoiseMs) || 0;
    if (!msg.speech) return { ok: true, speech: false, vadMs, denoiseMs };
    return { ok: true, speech: true, samples: msg.samples as Float32Array, speechSec: Number(msg.speechSec) || 0, vadMs, denoiseMs };
  }

  /**
   * Подготовка и распознавание установленной моделью sherpa (GigaAM, TASK-164.4). Модель не
   * установлена или процесс недоступен — `{ ok: false }`, рендерер распознаёт фразу Whisper.
   */
  async recognize(req: SpeechPrepRequest & { asr: InstalledAsrModel }): Promise<SpeechRecognizeResult> {
    const reply = await this.send({
      type: 'recognize',
      samples: req.samples,
      gate: req.gate,
      denoise: req.denoise,
      models: this.modelPaths(),
      asr: { model: req.asr.modelPath, tokens: req.asr.tokensPath }
    }, RECOGNIZE_TIMEOUT_MS);
    if (!reply.ok) return reply;
    const { msg } = reply;
    const vadMs = Number(msg.vadMs) || 0;
    const denoiseMs = Number(msg.denoiseMs) || 0;
    if (!msg.speech) return { ok: true, speech: false, vadMs, denoiseMs };
    return {
      ok: true,
      speech: true,
      text: typeof msg.text === 'string' ? msg.text : '',
      speechSec: Number(msg.speechSec) || 0,
      vadMs,
      denoiseMs,
      asrMs: Number(msg.asrMs) || 0
    };
  }

  dispose() {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'speech prep disposed' });
    }
    this.pending.clear();
    if (worker) worker.kill();
  }
}

export const speechPrepService = new SpeechPrepService();
