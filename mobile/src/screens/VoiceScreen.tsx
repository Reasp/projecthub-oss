import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { MicrophoneIcon, PaperPlaneRightIcon, SpeakerSlashIcon, StopIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useServices } from '../app/context';
import { fieldProps } from '../components/FieldEditor';
import { Button, Spinner } from '../components/ui';
import { useT } from '../i18n/react';
import { startVoiceListener, type VoiceListener } from '../platform/voiceListener';
import { startVoiceRecording, voiceAvailable, type VoiceRecording } from '../platform/voiceRecorder';
import type { PhoneVoiceScreen } from '../../../src/utils/phoneVoice';

/**
 * Голосовой режим (TASK-179.2, [[decision-137]] п. 1): лента реплик, большая кнопка микрофона, «нажми и говори» или
 * «слушать постоянно». Логика команд — в `VoiceController`, экран только пишет звук и показывает состояние.
 */
export function VoiceScreen({ open, onClose, onOpenScreen }: { open: boolean; onClose: () => void; onOpenScreen: (screen: PhoneVoiceScreen) => void }) {
  const { voice, platform, store, switchHost, profiles } = useServices();
  const tr = useT();
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const [handsFree, setHandsFree] = useState(false);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [hearing, setHearing] = useState(false);
  const [typed, setTyped] = useState('');
  const rec = useRef<VoiceRecording | null>(null);
  const listener = useRef<VoiceListener | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const available = voiceAvailable();

  useEffect(() => {
    voice.setActive(open);
    if (!open) {
      rec.current?.cancel();
      rec.current = null;
      setRecording(false);
    }
  }, [open, voice]);

  // Постоянное слушание: пока телефон занят фразой или говорит — пауза, чтобы эхо ответа не стало командой.
  useEffect(() => {
    if (!open || !handsFree || !available) return;
    let cancelled = false;
    void startVoiceListener({
      onPhrase: (samples) => void voice.handleAudio(samples, { handsFree: true }),
      onLevel: (l, speaking) => {
        setLevel(l);
        setHearing(speaking);
      }
    })
      .then((l) => {
        if (cancelled) l.stop();
        else listener.current = l;
      })
      .catch(() => {
        setHandsFree(false);
        voice.say(tr.studio.micDenied).catch(() => undefined);
      });
    return () => {
      cancelled = true;
      listener.current?.stop();
      listener.current = null;
      setLevel(0);
      setHearing(false);
    };
  }, [open, handsFree, available, voice, tr]);

  useEffect(() => {
    listener.current?.setPaused(state.phase !== 'idle');
  }, [state.phase]);

  // Пока открыт голосовой режим, экран не гаснет: при выключенном экране WebView не слушает микрофон.
  useEffect(() => {
    if (!open || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => undefined);
    };
  }, [open]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [state.log.length, state.confirm]);

  // «Открой задачи на макбуке»: другой ПК — переключиться на него, проект — выбрать, затем вкладка.
  const handledNav = useRef(0);
  useEffect(() => {
    const nav = state.nav;
    if (!open || !nav || nav.seq === handledNav.current) return;
    handledNav.current = nav.seq;
    if (nav.profileId && nav.profileId !== profiles.activeId) switchHost(nav.profileId);
    if (nav.hostId && nav.projectPath) void store.requestNav({ hostId: nav.hostId, projectPath: nav.projectPath, kind: 'project', sessionId: '' });
    onOpenScreen(nav.screen);
  }, [open, state.nav, profiles.activeId, switchHost, store, onOpenScreen]);

  if (!open) return null;

  const toggleRecording = async () => {
    if (recording) {
      const r = rec.current;
      rec.current = null;
      setRecording(false);
      platform.haptic('light');
      if (!r) return;
      try {
        await voice.handleAudio(await r.stop());
      } catch {
        // Пустая или испорченная запись — молча ждём следующую.
      }
      return;
    }
    voice.stopSpeaking();
    try {
      rec.current = await startVoiceRecording(() => void toggleRecording());
      setRecording(true);
      platform.haptic('medium');
    } catch {
      await voice.say(tr.studio.micDenied);
    }
  };

  const status =
    state.phase === 'recognizing'
      ? tr.voice.recognizing
      : state.phase === 'thinking'
        ? tr.voice.thinking
        : state.phase === 'speaking'
          ? tr.voice.speaking
          : recording
            ? tr.voice.tapToStop
            : handsFree
              ? hearing
                ? tr.voice.hearing
                : tr.voice.listening
              : tr.voice.idle;
  const busy = state.phase === 'recognizing' || state.phase === 'thinking';
  const sendTyped = (value = typed) => {
    const text = value.trim();
    if (!text || busy) return;
    setTyped('');
    voice.stopSpeaking();
    void voice.handleText(text);
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={tr.voice.title} data-testid="voice-screen" className="fixed inset-0 z-[9999] flex flex-col bg-ph-base pb-safe pt-safe">
      <div className="flex shrink-0 items-center gap-2 border-b border-ph-line px-2 py-1.5">
        <button type="button" aria-label={tr.common.close} onClick={onClose} className="rounded-full p-2 text-slate-300 active:bg-ph-hover">
          <XIcon size={22} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold">{tr.voice.title}</div>
          {state.context && <div className="truncate text-[12px] text-slate-400" data-testid="voice-context">{state.context}</div>}
        </div>
        <div className="flex rounded-lg bg-ph-raised p-0.5" role="radiogroup" aria-label={tr.voice.language}>
          {(['ru', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={state.lang === l}
              onClick={() => voice.setLang(l)}
              className={clsx('rounded-md px-2.5 py-1 text-[12px] font-semibold uppercase', state.lang === l ? 'bg-ph-elevated text-slate-100' : 'text-slate-400')}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3" data-testid="voice-log">
        {state.log.length === 0 && (
          <div className="pt-6 text-center text-[14px] text-slate-400">
            {!available && <p className="mb-4 text-amber-300">{tr.voice.noVoice}</p>}
            {!platform.tts && <p className="mb-4">{tr.voice.noTtsHint}</p>}
            <ul className="space-y-2">
              {tr.voice.examples.map((e) => (
                <li key={e}>
                  <button
                    type="button"
                    data-testid="voice-example"
                    onClick={() => sendTyped(e)}
                    className="w-full rounded-xl border border-ph-line px-3 py-2 italic active:bg-ph-hover"
                  >
                    «{e}»
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.log.map((m) => (
          <div key={m.id} className={clsx('flex', m.who === 'you' ? 'justify-end' : 'justify-start')}>
            <div
              data-testid={m.who === 'you' ? 'voice-you' : 'voice-me'}
              className={clsx(
                'max-w-[85%] rounded-2xl px-3 py-2 text-[15px] leading-snug',
                m.who === 'you' ? 'rounded-br-sm bg-indigo-600 text-white' : 'rounded-bl-sm bg-ph-raised text-slate-100'
              )}
            >
              {m.text}
            </div>
          </div>
        ))}
        {state.confirm && (
          <div className="flex gap-2 pt-1" data-testid="voice-confirm">
            <Button className="flex-1" onClick={() => void voice.answer(false)}>
              {tr.voice.no}
            </Button>
            <Button className="flex-1" variant="primary" haptic="medium" onClick={() => void voice.answer(true)}>
              {tr.voice.yes}
            </Button>
          </div>
        )}
        <div ref={logEnd} />
      </div>

      <div className="shrink-0 border-t border-ph-line px-4 pb-3 pt-3">
        <div className="mb-3 text-center text-[13px] text-slate-400" data-testid="voice-status">
          {busy && <Spinner className="mr-2 align-[-2px]" />}
          {status}
        </div>
        <div className="flex items-center justify-center gap-6">
          <div className="w-12">
            {state.phase === 'speaking' && (
              <button type="button" aria-label={tr.voice.speaking} onClick={() => voice.stopSpeaking()} className="rounded-full p-3 text-slate-300 active:bg-ph-hover">
                <SpeakerSlashIcon size={24} />
              </button>
            )}
          </div>
          <button
            type="button"
            data-testid="voice-mic"
            aria-label={recording ? tr.voice.tapToStop : tr.voice.pushToTalk}
            disabled={!available || handsFree || busy}
            onClick={() => void toggleRecording()}
            className={clsx(
              'relative flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95 disabled:opacity-50',
              recording ? 'bg-rose-600' : handsFree ? 'bg-emerald-600' : 'bg-indigo-500'
            )}
            style={handsFree ? { boxShadow: `0 0 0 ${Math.round(level * 18)}px rgba(16,185,129,0.25)` } : undefined}
          >
            {recording ? <StopIcon size={30} weight="fill" /> : <MicrophoneIcon size={32} weight="fill" />}
          </button>
          <div className="w-12" />
        </div>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendTyped();
          }}
        >
          <input
            {...fieldProps({ value: typed, onChange: setTyped, placeholder: tr.voice.typeCommand, onSubmit: sendTyped, submitLabel: tr.voice.send })}
            data-testid="voice-text"
            enterKeyHint="send"
            className="h-10 min-w-0 flex-1 rounded-xl border border-ph-line bg-ph-raised px-3 text-[14px] outline-none focus:border-indigo-500"
          />
          <button type="submit" aria-label={tr.voice.send} data-testid="voice-text-send" disabled={!typed.trim() || busy} className="rounded-full p-2 text-indigo-300 active:bg-ph-hover disabled:opacity-40">
            <PaperPlaneRightIcon size={22} weight="fill" />
          </button>
        </form>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-ph-raised p-1">
          {([false, true] as const).map((mode) => (
            <button
              key={String(mode)}
              type="button"
              data-testid={mode ? 'voice-handsfree' : 'voice-ptt'}
              aria-pressed={handsFree === mode}
              disabled={!available}
              onClick={() => {
                platform.haptic('selection');
                rec.current?.cancel();
                rec.current = null;
                setRecording(false);
                setHandsFree(mode);
              }}
              className={clsx('rounded-lg py-1.5 text-[13px]', handsFree === mode ? 'bg-ph-elevated font-medium text-slate-100' : 'text-slate-400')}
            >
              {mode ? tr.voice.handsFree : tr.voice.pushToTalk}
            </button>
          ))}
        </div>
        {handsFree && (
          <label className="mt-2 flex items-center gap-2 text-[13px] text-slate-300" title={tr.voice.wakeHint}>
            <input type="checkbox" data-testid="voice-wake" checked={state.wake} onChange={(e) => voice.setWake(e.target.checked)} />
            {tr.voice.wakeWord}
          </label>
        )}
      </div>
    </div>,
    document.body
  );
}
