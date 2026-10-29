import React, { useState, useRef, useEffect, memo } from 'react';
import { Send, Square, CheckSquare, GitBranch, BookOpen, Mic, Radio, Zap, ListTodo, GitCommit, Rocket, Landmark, At } from '../common/icons';
import type { BacklogTask, GitRepoDetails } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { voiceService, type VoiceState } from '../../services/voiceService';
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
}

export const PromptInputArea: React.FC<PromptInputAreaProps> = memo(({
  isStreaming,
  tasks,
  gitRepoDetails,
  onSend,
  onAbort,
  footerStart,
  footerEnd
}) => {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const offState = voiceService.onStateChange((st: VoiceState) => {
      setVoiceState(st);
    });

    const offResult = voiceService.onResult((text: string, isFinal: boolean) => {
      if (isFinal && text.trim()) {
        // If recording was initiated, append to input
        setInput((prev) => (prev ? `${prev} ${text.trim()}` : text.trim()));
      }
    });

    // Без отписки каждое перемонтирование поля добавляло ещё один слушатель: фраза вставлялась несколько раз.
    return () => {
      offState();
      offResult();
    };
  }, []);

  const isHandsFree = voiceService.isListening;
  const isSpeech = voiceState === 'speech_detected';
  const isTranscribing = voiceState === 'transcribing';

  const handleToggleVoiceDictation = () => {
    voiceService.toggleHandsFree();
  };

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    const textToSend = input.trim();
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    if (textToSend.toLowerCase() === '/usage' || textToSend.toLowerCase() === '/cost') {
      window.dispatchEvent(new CustomEvent('projecthub:open-claude-usage'));
      return;
    }

    onSend(textToSend);
  };

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
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder={isHandsFree ? t.aiStudio.input.handsFreePlaceholder : t.aiStudio.input.placeholder}
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
              disabled={isStreaming}
              trigger={<Zap className="w-4 h-4" />}
              testId="composer-quick-menu"
            />
          </div>

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

          {/* Voice Dictation Button in Prompt Box */}
          <div className="relative inline-flex items-center shrink-0">
            <button
              type="button"
              onClick={handleToggleVoiceDictation}
              className={`p-1.5 rounded-lg transition flex items-center justify-center shrink-0 ${
                isSpeech
                  ? 'bg-emerald-600 text-white ring-2 ring-emerald-500/40 animate-pulse'
                  : isTranscribing
                  ? 'bg-amber-600 text-white'
                  : isHandsFree
                  ? 'bg-indigo-600 text-white ring-2 ring-indigo-500/40'
                  : 'text-slate-400 hover:text-indigo-300 hover:bg-ph-raised'
              }`}
              title={isHandsFree ? t.aiStudio.input.handsFreeDisableTitle : t.aiStudio.input.handsFreeEnableTitle}
            >
              <Mic className="w-4 h-4" />
            </button>
            <VoiceBadge
              command={t.aiStudio.input.voicePromptCmd}
              altCommand={t.aiStudio.input.voiceAskCmd}
              position="top"
            />
          </div>

          {isStreaming ? (
            <button
              type="button"
              onClick={onAbort}
              className="ph-btn ph-btn-danger shrink-0"
              title={t.aiStudio.input.stop}
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>{t.aiStudio.input.stop}</span>
            </button>
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
