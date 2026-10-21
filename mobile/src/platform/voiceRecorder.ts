import { VOICE_MAX_SECONDS, downmixAndResample } from '../protocol/voice';

/**
 * Запись голоса в WebView (TASK-140.7, decision-121 п. 4): `MediaRecorder` → `decodeAudioData` → моно 16 кГц. Звук не
 * распознаётся на телефоне и не уходит в облако — его распознаёт ПК.
 */

export function voiceAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined' && typeof window !== 'undefined' && window.isSecureContext;
}

export interface VoiceRecording {
  /** Остановить и получить звук 16 кГц моно. */
  stop(): Promise<Float32Array>;
  cancel(): void;
}

/** Начать запись. Через 90 секунд запись останавливается сама — `onLimit` сообщает об этом. */
export async function startVoiceRecording(onLimit: () => void): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  recorder.start(1000);
  const limit = setTimeout(() => {
    if (recorder.state === 'recording') {
      onLimit();
      recorder.stop();
    }
  }, VOICE_MAX_SECONDS * 1000);

  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state === 'recording') recorder.stop();
      await stopped;
      release();
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const ctx = new AudioContext();
      try {
        const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        return downmixAndResample(channels, audio.sampleRate);
      } finally {
        void ctx.close();
      }
    },
    cancel() {
      clearTimeout(limit);
      if (recorder.state === 'recording') recorder.stop();
      release();
    }
  };
}
