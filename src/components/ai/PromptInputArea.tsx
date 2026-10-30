import React, { useState, useRef, useEffect, memo } from 'react';
import { Send, Square, CheckSquare, GitBranch, BookOpen, Mic, Radio, Zap, ListTodo, ListPlus, GitCommit, Rocket, Landmark, At } from '../common/icons';
import type { BacklogTask, GitRepoDetails } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { voiceService, type VoiceState } from '../../services/voiceService';
import {
  appendDictationChunk,
  appendDictationNewline,
  getPromptDictationTarget,
  registerPromptDictationTarget
} from '../../services/promptDictation';
import { VoiceBadge } from '../voice/VoiceBadge';
import { ComposerMenu, type ComposerMenuItem } from './ComposerMenu';

interface PromptInputAreaProps {
  mode: 'agent' | 'chat' | 'architect';
  isStreaming: boolean;
  tasks: BacklogTask[];
  gitRepoDetails: GitRepoDetails | null;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** Начало нижней строки поля ввода: агент вкладки и режим (TASK-169, TASK-170). */
  footerStart?: React.ReactNode;
  /** Перед микрофоном: авто-подтверждение. */
  footerEnd?: React.ReactNode;
  /** Текст, который надо поставить в поле: откат `/rewind` возвращает реплику (TASK-284); `nonce` — повтор того же. */
  prefill?: { text: string; nonce: number } | null;
  /** Поле приняло `prefill`. */
  onPrefillApplied?: () => void;
}

export const PromptInputArea: React.FC<PromptInputAreaProps> = memo(({
  isStreaming,
  tasks,
  gitRepoDetails,
  onSend,
  onAbort,
  footerStart,
  footerEnd,
  prefill,
  onPrefillApplied
}) => {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [promptDictation, setPromptDictation] = useState(voiceService.isPromptDictationActive);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Текст поля для диктовки: две фразы подряд приходят раньше перерисовки. */
  const inputRef = useRef(input);

  useEffect(() => {
    inputRef.current = input;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (input) {
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      el.scrollTop = el.scrollHeight;
    }
  }, [input]);

  const prefillNonce = prefill?.nonce;
  const prefillText = prefill?.text;
  const onPrefillAppliedRef = useRef(onPrefillApplied);
  useEffect(() => {
    onPrefillAppliedRef.current = onPrefillApplied;
  });
  useEffect(() => {
    if (prefillNonce === undefined || prefillText === undefined) return;
    inputRef.current = prefillText;
    setInput(prefillText);
    textareaRef.current?.focus();
    onPrefillAppliedRef.current?.();
  }, [prefillNonce, prefillText]);

  // Распознанная речь сама в поле не попадает (TASK-275): вне диктовки это команды, а не текст промпта.
  useEffect(() => {
    const offState = voiceService.onStateChange((st: VoiceState) => {
      setVoiceState(st);
    });
    const offDictation = voiceService.onPromptDictationChange(setPromptDictation);
    return () => {
      offState();
      offDictation();
    };
  }, []);

  const isHandsFree = voiceService.isListening;
  const isSpeech = voiceState === 'speech_detected';
  const isTranscribing = voiceState === 'transcribing';

  const handleToggleVoiceDictation = () => {
    if (voiceService.isPromptDictationActive) {
      voiceService.stopPromptDictation();
    } else {
      void voiceService.startPromptDictation();
    }
  };

  // Во время ответа сообщение не теряется, а встаёт в очередь вкладки (TASK-273).
  const sendText = (text: string): boolean => {
    const textToSend = text.trim();
    if (!textToSend) return false;
    inputRef.current = '';
    setInput('');

    if (textToSend.toLowerCase() === '/usage' || textToSend.toLowerCase() === '/cost') {
      window.dispatchEvent(new CustomEvent('projecthub:open-claude-usage'));
      return true;
    }

    onSend(textToSend);
    return true;
  };

  const handleSend = () => {
    sendText(input);
  };

  const sendTextRef = useRef(sendText);
  useEffect(() => {
    sendTextRef.current = sendText;
  });

  // Поле открытой вкладки принимает голосовую диктовку; ушли из Studio — диктовать некуда.
  useEffect(() => {
    const unregister = registerPromptDictationTarget({
      apply: (text, command) => {
        let next = appendDictationChunk(inputRef.current, text);
        if (command === 'clear') next = '';
        if (command === 'newline') next = appendDictationNewline(next);
        if (command === 'send') return { sent: sendTextRef.current(next) };
        inputRef.current = next;
        setInput(next);
        return { sent: false };
      }
    });
    return () => {
      unregister();
      // StrictMode снимает поле и тут же монтирует снова — режим гасим, только если поле не вернулось.
      setTimeout(() => {
        if (!getPromptDictationTarget()) voiceService.stopPromptDictation();
      }, 0);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInsertContext = (type: 'task' | 'git' | 'docs') => {
    if (type === 'task') {
      const active = tasks.find((tk) => tk.status === 'In Progress') || tasks[0];
      if (active) {
        setInput((prev) => `${prev} @Task(${active.id}: ${active.title}) `);
      } else {
        setInput((prev) => `${prev} @BacklogTasks `);
      }
    } else if (type === 'git') {
      const branch = gitRepoDetails?.currentBranch || 'main';
      const changed = gitRepoDetails?.files.length || 0;
      setInput((prev) => `${prev} @Git(Branch: ${branch}, Changed Files: ${changed}) `);
    } else if (type === 'docs') {
      setInput((prev) => `${prev} @ProjectDocs `);
    }
    textareaRef.current?.focus();
  };

  const contextItems: ComposerMenuItem[] = [
    { key: 'task', label: '@Task', icon: <CheckSquare className="w-3.5 h-3.5 text-amber-400" />, onSelect: () => handleInsertContext('task') },
    { key: 'git', label: '@GitStatus', icon: <GitBranch className="w-3.5 h-3.5 text-indigo-400" />, onSelect: () => handleInsertContext('git') },
    { key: 'docs', label: '@Docs', icon: <BookOpen className="w-3.5 h-3.5 text-purple-400" />, onSelect: () => handleInsertContext('docs') }
  ];

  const quickItems: ComposerMenuItem[] = [
    {
      key: 'next-task',
      label: t.aiStudio.quickActions.nextTask,
      hint: t.aiStudio.quickActions.nextTaskPrompt,
      icon: <ListTodo className="w-3.5 h-3.5 text-indigo-400" />,
      onSelect: () => onSend(t.aiStudio.quickActions.nextTaskPrompt)
    },
    {
      key: 'commit',
      label: t.aiStudio.quickActions.commit,
      hint: t.aiStudio.quickActions.commitPrompt,
      icon: <GitCommit className="w-3.5 h-3.5 text-emerald-400" />,
      onSelect: () => onSend(t.aiStudio.quickActions.commitPrompt)
    },
    {
      key: 'deploy',
      label: t.aiStudio.quickActions.deploy,
      hint: t.aiStudio.quickActions.deployPrompt,
      icon: <Rocket className="w-3.5 h-3.5 text-purple-400" />,
      onSelect: () => onSend(t.aiStudio.quickActions.deployPrompt)
    },
    {
      key: 'adr',
      label: t.aiStudio.promptCards.adrCreate,
      hint: t.aiStudio.promptCards.adrCreateDesc,
      icon: <Landmark className="w-3.5 h-3.5 text-slate-400" />,
      onSelect: () => onSend(t.aiStudio.promptCards.adrCreatePrompt)
    }
  ];

  return (
    <div className="px-4 pt-2 pb-3 bg-ph-elevated border-t border-slate-800 shrink-0">
      {/*
        Поле ввода с нижней строкой (TASK-169): агент вкладки, режим, вставка контекста и быстрые команды —
        слева, авто-подтверждение, микрофон и отправка — справа. Отдельных строк над полем нет.
      */}
      <div className="bg-ph-hover border border-slate-700/80 rounded-2xl px-2.5 pt-2 pb-1.5 shadow-inner focus-within:border-indigo-500 transition">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-gramm="false"
          data-enable-grammarly="false"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            promptDictation
              ? t.aiStudio.input.promptDictationPlaceholder
              : isHandsFree
                ? t.aiStudio.input.handsFreePlaceholder
                : t.aiStudio.input.placeholder
          }
          className="w-full bg-transparent text-xs text-white placeholder:text-slate-500 focus:outline-none resize-none font-sans px-1.5 py-1 leading-relaxed max-h-44"
        />

        <div className="flex items-center gap-0.5 mt-1 min-w-0">
          <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto no-scrollbar">
            {footerStart}
            <ComposerMenu
              title={t.aiStudio.input.contextTags}
              heading={t.aiStudio.input.contextTags}
              items={contextItems}
              trigger={<At className="w-4 h-4" />}
              testId="composer-context-menu"
            />
            <ComposerMenu
              title={t.aiStudio.input.quickPrompts}
              heading={t.aiStudio.input.quickPrompts}
              items={quickItems}
              trigger={<Zap className="w-4 h-4" />}
              testId="composer-quick-menu"
            />
          </div>

          {promptDictation && !isSpeech && !isTranscribing && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 text-[11px] shrink-0"
              data-testid="prompt-dictation-badge"
            >
              <Mic className="w-3 h-3 text-rose-400" />
              <span>{t.aiStudio.input.promptDictationBadge}</span>
            </div>
          )}

          {/* Live Audio Status */}
          {isSpeech && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[11px] animate-pulse shrink-0">
              <Radio className="w-3 h-3 text-emerald-400" />
              <span>{t.voice.listeningSpeech}</span>
            </div>
          )}
          {isTranscribing && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[11px] animate-pulse shrink-0">
              <Zap className="w-3 h-3 text-amber-400 animate-spin" />
              <span>{t.voice.inferring}</span>
            </div>
          )}

          {footerEnd}

          {/* Диктовка промпта в это поле (TASK-275) */}
          <div className="relative inline-flex items-center shrink-0">
            <button
              type="button"
              onClick={handleToggleVoiceDictation}
              aria-pressed={promptDictation}
              data-testid="prompt-dictation-toggle"
              className={`p-1.5 rounded-lg transition flex items-center justify-center shrink-0 ${
                promptDictation && isSpeech
                  ? 'bg-emerald-600 text-white ring-2 ring-emerald-500/40 animate-pulse'
                  : promptDictation && isTranscribing
                  ? 'bg-amber-600 text-white'
                  : promptDictation
                  ? 'bg-rose-600 text-white ring-2 ring-rose-500/40'
                  : 'text-slate-400 hover:text-indigo-300 hover:bg-ph-raised'
              }`}
              title={promptDictation ? t.aiStudio.input.promptDictationStopTitle : t.aiStudio.input.promptDictationStartTitle}
            >
              <Mic className="w-4 h-4" />
            </button>
            <VoiceBadge command={t.aiStudio.input.promptDictationCmd} position="top" />
          </div>

          {isStreaming ? (
            <>
              {input.trim() && (
                <button
                  type="button"
                  onClick={handleSend}
                  className="ph-btn ph-btn-secondary shrink-0"
                  title={t.aiStudio.input.queueSend}
                  data-testid="composer-queue-send"
                >
                  <ListPlus className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={onAbort}
                className="ph-btn ph-btn-danger shrink-0"
                title={t.aiStudio.input.stop}
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>{t.aiStudio.input.stop}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!input.trim()}
              className="ph-btn ph-btn-primary disabled:opacity-40 disabled:hover:bg-indigo-600 shrink-0"
              title={`${t.aiStudio.input.send} (Enter)`}
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
