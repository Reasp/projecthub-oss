/**
 * Подготовка звука фразы перед распознаванием (TASK-164.2, decision-94): шумодав и Silero VAD
 * на `sherpa-onnx-node`; `recognize` следом распознаёт фразу локальной моделью GigaAM (TASK-164.4). Модуль не зависит от Electron: его грузит процесс `speechWorker.mjs`,
 * а тест — обычный node в отдельном процессе (в одном процессе с `onnxruntime-node` sherpa грузить
 * нельзя, decision-34).
 *
 * Вызовы — с `enableExternalBuffer: false`: в Electron V8 external buffers запрещены.
 */
import { planChunks, speechWindow } from './speechGate.mjs';

export const SAMPLE_RATE = 16000;
/** Окно Silero VAD для 16 кГц. */
const VAD_WINDOW = 512;

/** @param {() => any} loadSherpa ленивая загрузка `sherpa-onnx-node` */
export function createSpeechPreparer(loadSherpa) {
  /** Шумодавы по пути модели: создаются при первом использовании. */
  const denoisers = new Map();

  function getDenoiser(kind, model) {
    const key = `${kind}|${model}`;
    let denoiser = denoisers.get(key);
    if (!denoiser) {
      const modelConfig = kind === 'gtcrn' ? { gtcrn: { model } } : { dpdfnet: { model } };
      denoiser = new (loadSherpa().OfflineSpeechDenoiser)({
        model: { ...modelConfig, numThreads: 1, debug: 0, provider: 'cpu' }
      });
      denoisers.set(key, denoiser);
    }
    return denoiser;
  }

  /**
   * Отрезки речи в сэмплах. Детектор создаётся на каждую фразу: отсчёт `start` гарантированно идёт
   * от начала фразы, а загрузка модели в 0,6 МБ стоит миллисекунды.
   */
  function detectSpeech(samples, model) {
    const vad = new (loadSherpa().Vad)(
      {
        sileroVad: {
          model,
          threshold: 0.5,
          minSilenceDuration: 0.3,
          minSpeechDuration: 0.25,
          windowSize: VAD_WINDOW,
          maxSpeechDuration: 30
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: 0,
        provider: 'cpu'
      },
      Math.ceil(samples.length / SAMPLE_RATE) + 5
    );
    const segments = [];
    const drain = () => {
      while (!vad.isEmpty()) {
        const seg = vad.front(false);
        segments.push([seg.start, seg.start + seg.samples.length]);
        vad.pop();
      }
    };
    for (let i = 0; i + VAD_WINDOW <= samples.length; i += VAD_WINDOW) {
      vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW));
      drain();
    }
    vad.flush();
    drain();
    return segments;
  }

  /**
   * @param {{ samples: Float32Array, gate: boolean, denoise: 'off'|'gtcrn'|'dpdfnet', models: { vad?: string, gtcrn?: string, dpdfnet?: string } }} req
   */
  /** Подготовка с отрезками речи в координатах результата — они нужны для нарезки длинной фразы. */
  function prepareWithSegments({ samples: input, gate, denoise, models }) {
    let samples = input instanceof Float32Array ? input : new Float32Array(input);
    let denoiseMs = 0;
    let vadMs = 0;

    if (denoise && denoise !== 'off' && models?.[denoise]) {
      const started = Date.now();
      const out = getDenoiser(denoise, models[denoise]).run({ samples, sampleRate: SAMPLE_RATE, enableExternalBuffer: false });
      samples = Float32Array.from(out.samples);
      denoiseMs = Date.now() - started;
    }

    if (!gate || !models?.vad) {
      return { speech: true, samples, speechSec: samples.length / SAMPLE_RATE, denoiseMs, vadMs, segments: [] };
    }

    const started = Date.now();
    const segments = detectSpeech(samples, models.vad);
    vadMs = Date.now() - started;
    const window = speechWindow(segments, samples.length, SAMPLE_RATE);
    if (!window) return { speech: false, speechSec: 0, denoiseMs, vadMs, segments };
    return {
      speech: true,
      samples: samples.slice(window.start, window.end),
      speechSec: window.speechSec,
      denoiseMs,
      vadMs,
      segments: segments.map(([s, e]) => [s - window.start, e - window.start])
    };
  }

  /**
   * @param {{ samples: Float32Array, gate: boolean, denoise: 'off'|'gtcrn'|'dpdfnet', models: { vad?: string, gtcrn?: string, dpdfnet?: string } }} req
   */
  function prepare(req) {
    const { segments, ...result } = prepareWithSegments(req);
    return { ...result, segments: segments.length };
  }

  /** Распознаватели по пути модели: загрузка GigaAM — около секунды, держим загруженным. */
  const recognizers = new Map();

  function getRecognizer(asr) {
    let recognizer = recognizers.get(asr.model);
    if (!recognizer) {
      recognizer = new (loadSherpa().OfflineRecognizer)({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 64 },
        modelConfig: { nemoCtc: { model: asr.model }, tokens: asr.tokens, numThreads: asr.numThreads || 4, provider: 'cpu', debug: 0 },
        decodingMethod: 'greedy_search'
      });
      recognizers.set(asr.model, recognizer);
    }
    return recognizer;
  }

  /**
   * Подготовка и распознавание локальной моделью sherpa (GigaAM, TASK-164.4) одним вызовом: звук
   * не возвращается в рендерер ради второго похода в процесс.
   *
   * @param {Parameters<typeof prepare>[0] & { asr: { model: string, tokens: string, numThreads?: number } }} req
   */
  function recognize(req) {
    const { samples, segments, ...prep } = prepareWithSegments(req);
    if (!prep.speech) return { ...prep, segments: segments.length };
    const started = Date.now();
    const recognizer = getRecognizer(req.asr);
    // Длинная запись push-to-talk — кусками по паузам: модель рассчитана на фразы до ~25 с
    const parts = [];
    for (const [start, end] of planChunks(segments, samples.length, SAMPLE_RATE)) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: samples.subarray(start, end), sampleRate: SAMPLE_RATE });
      recognizer.decode(stream);
      // Токены GigaAM иногда дают двойные пробелы между словами
      const part = recognizer.getResult(stream).text.replace(/\s+/g, ' ').trim();
      if (part) parts.push(part);
    }
    return { ...prep, segments: segments.length, text: parts.join(' '), asrMs: Date.now() - started };
  }

  return { prepare, recognize };
}
