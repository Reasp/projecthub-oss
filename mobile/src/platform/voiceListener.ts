import { downmixAndResample } from '../protocol/voice';
import { VadSegmenter } from '../protocol/vad';

/**
 * Постоянное слушание голосового режима (TASK-179.2, [[decision-137]] п. 1): микрофон → кадры Web Audio → VAD →
 * готовая фраза моно 16 кГц. Пока телефон говорит, слушание стоит на паузе: эхо ответа не должно стать командой.
 */

export interface VoiceListener {
  /** Поставить на паузу (телефон говорит) и продолжить. Начатая фраза при паузе отбрасывается. */
  setPaused(paused: boolean): void;
  stop(): void;
}

const FRAME = 2048;

export async function startVoiceListener(handlers: {
  onPhrase: (samples: Float32Array) => void;
  /** Уровень звука 0..1 и идёт ли речь — для индикатора на экране. */
  onLevel?: (level: number, speaking: boolean) => void;
}): Promise<VoiceListener> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor устарел, но работает во всех WebView и не требует отдельного файла ворклета.
  const node = ctx.createScriptProcessor(FRAME, 1, 1);
  const vad = new VadSegmenter({ sampleRate: ctx.sampleRate, frameSize: FRAME });
  let paused = false;
  node.onaudioprocess = (e) => {
    if (paused) return;
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    const phrase = vad.push(frame);
    handlers.onLevel?.(Math.min(1, Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length) * 8), vad.isSpeaking());
    if (phrase) handlers.onPhrase(downmixAndResample([phrase], ctx.sampleRate));
  };
  source.connect(node);
  // Без выхода в граф Chrome не вызывает onaudioprocess; выход заглушён.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();

  return {
    setPaused(next) {
      paused = next;
      if (next) vad.reset();
    },
    stop() {
      node.onaudioprocess = null;
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    }
  };
}
