import { useEffect, useRef, useState } from 'react';
import { MicrophoneIcon, StopIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useServices } from '../app/context';
import { Spinner } from '../components/ui';
import { startVoiceRecording, voiceAvailable, type VoiceRecording } from '../platform/voiceRecorder';

/**
 * Язык распознавания: русская локаль телефона — русский (с GigaAM, если она стоит на ПК), иначе автоопределение
 * Whisper. Явный английский не задаётся: Whisper с `en` переводит русскую речь, а не распознаёт её.
 */
function phoneLanguage(): 'ru' | 'auto' {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'ru').toLowerCase();
  return lang.startsWith('ru') ? 'ru' : 'auto';
}

/**
 * Голосовой промпт (TASK-140.7, [[decision-121]] п. 4): нажать — запись, нажать ещё раз — запись уходит на ПК, текст
 * встаёт в поле промпта. Пока идёт запись, кнопка показывает время; крестик отменяет запись.
 */
export function VoiceButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const { store, platform } = useServices();
  const [state, setState] = useState<'idle' | 'recording' | 'sending'>('idle');
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<VoiceRecording | null>(null);

  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);
  useEffect(() => () => recording.current?.cancel(), []);

  if (!voiceAvailable()) return null;

  const finish = async () => {
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    setState('sending');
    platform.haptic('light');
    try {
      const samples = await rec.stop();
      const text = await store.transcribeVoice(samples, phoneLanguage());
      if (text) onText(text);
    } catch (err) {
      store.showToast(`Запись не получилась: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setState('idle');
    }
  };

  const start = async () => {
    try {
      recording.current = await startVoiceRecording(() => void finish());
      setSeconds(0);
      setState('recording');
      platform.haptic('medium');
    } catch {
      store.showToast('Нет доступа к микрофону: разрешите его ProjectHub в настройках телефона', 'error');
    }
  };

  if (state === 'recording') {
    return (
      <div className="mb-1 flex shrink-0 items-center gap-1" data-testid="voice-recording">
        <button
          type="button"
          aria-label="Отменить запись"
          onClick={() => {
            recording.current?.cancel();
            recording.current = null;
            setState('idle');
          }}
          className="rounded-full p-2 text-slate-400 active:bg-ph-hover"
        >
          <XIcon size={18} />
        </button>
        <button
          type="button"
          aria-label="Готово — распознать на ПК"
          data-testid="voice-stop"
          onClick={() => void finish()}
          className="flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-2 text-[13px] font-medium text-white active:bg-rose-700"
        >
          <StopIcon size={14} weight="fill" /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label="Голосовой промпт"
      data-testid="voice-start"
      disabled={disabled || state === 'sending'}
      onClick={() => void start()}
      className={clsx('-ml-2 mb-1 shrink-0 rounded-full p-2 active:bg-ph-hover disabled:opacity-40', state === 'sending' ? 'text-indigo-300' : 'text-slate-300')}
    >
      {state === 'sending' ? <Spinner className="h-[22px] w-[22px]" /> : <MicrophoneIcon size={22} />}
    </button>
  );
}
