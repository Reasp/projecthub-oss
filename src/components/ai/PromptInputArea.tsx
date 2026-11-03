import React, { useState, useRef, useEffect, useLayoutEffect, memo } from 'react';
import { Send, Square, CheckSquare, GitBranch, BookOpen, Mic, Radio, Zap, ListTodo, ListPlus, GitCommit, Rocket, Landmark, At, File as FileIcon, Folder, Paperclip, X } from '../common/icons';
import type { BacklogTask, CliCommandList, GitRepoDetails } from '../../types/electron';
import { ComposerSuggestions, type ComposerSuggestionItem } from './ComposerSuggestions';
import { applyCompletion, completionToken, mentionText } from '../../lib/composerCompletion';
import { HISTORY_START, caretOnFirstLine, caretOnLastLine, historyStep, type HistoryNav } from '../../lib/promptHistory';
import { slashSuggestions } from '../../lib/studioHelp';
import { studioCliText } from '../../i18n/studioCliText';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { voiceService, type VoiceState } from '../../services/voiceService';
import {
  appendDictationChunk,
  appendDictationNewline,
  getPromptDictationTarget,
  registerPromptDictationTarget
} from '../../services/promptDictation';
import { VoiceBadge } from '../voice/VoiceBadge';
import { ComposerMenu, type ComposerMenuItem } from './ComposerMenu';
import { attachmentPayload } from '../../lib/attachmentImage';
import {
  PROMPT_ATTACHMENT_MAX_BYTES,
  PROMPT_ATTACHMENT_MAX_COUNT,
  formatAttachmentSize,
  isPreviewableImage,
  mimeFromName,
  type PromptAttachment
} from '../../lib/promptAttachments';
import { STUDIO_ESC_DOUBLE_MS, hasEscOverlay, isPlainEscape, studioEscAction } from '../../lib/studioEscape';

/** Вложение в поле ввода: сохраняется, готово или с ошибкой. */
interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Превью картинки — object URL исходного файла. */
  previewUrl?: string;
  saved?: PromptAttachment;
}

/** Источники автодополнения поля (TASK-300): файлы каталога вкладки и команды Claude Code. */
export interface ComposerCompletion {
  /** Вкладка идёт в Claude Code CLI: в `/` есть команды CLI и терминальные. */
  cliTab: boolean;
  searchFiles: (query: string) => Promise<{ entries: Array<{ path: string; dir: boolean }>; truncated: boolean }>;
  peekCliCommands: () => CliCommandList | null | undefined;
  loadCliCommands: () => Promise<CliCommandList | null>;
}

/** Предел файлов в поиске `@` — в подсказке, если проект больше (повторяет `MAX_INDEX_FILES` main). */
const FILE_INDEX_LIMIT = 50_000;

interface PromptInputAreaProps {
  mode: 'agent' | 'chat' | 'architect';
  isStreaming: boolean;
  tasks: BacklogTask[];
  gitRepoDetails: GitRepoDetails | null;
  onSend: (text: string, attachments: PromptAttachment[]) => void;
  /** Сохранить вложение в каталог вложений вкладки (TASK-289); без колбэка поле вложений не принимает. */
  onSaveAttachment?: (payload: { name: string; mime: string; data: string }) => Promise<PromptAttachment>;
  onAbort: () => void;
  /** Начало нижней строки поля ввода: агент вкладки и режим (TASK-169, TASK-170). */
  footerStart?: React.ReactNode;
  /** Перед микрофоном: авто-подтверждение. */
  footerEnd?: React.ReactNode;
  /** Текст, который надо поставить в поле: откат `/rewind` возвращает реплику (TASK-284); `nonce` — повтор того же. */
  prefill?: { text: string; nonce: number } | null;
  /** Поле приняло `prefill`. */
  onPrefillApplied?: () => void;
  /** Во вкладке есть разговор Claude Code для отката: Esc Esc при пустом поле открывает окно отката (TASK-299). */
  canRewind?: boolean;
  onRewind?: () => void;
  /** Esc занят карточкой на ленте вкладки (подтверждение действия агента) — поле его не трогает. */
  escapeBlocked?: boolean;
  /** Промпты для ↑/↓ от нового к старому (TASK-300); зовётся на нажатие, чтобы не считать историю на каждый кадр. */
  getHistory?: () => readonly string[];
  completion?: ComposerCompletion;
}

export const PromptInputArea: React.FC<PromptInputAreaProps> = memo(({
  isStreaming,
  tasks,
  gitRepoDetails,
  onSend,
  onSaveAttachment,
  onAbort,
  footerStart,
  footerEnd,
  prefill,
  onPrefillApplied,
  canRewind = false,
  onRewind,
  escapeBlocked = false,
  getHistory,
  completion
}) => {
  const { t, language } = useTranslation();
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
    historyNavRef.current = HISTORY_START;
    setInput(prefillText);
    textareaRef.current?.focus();
    onPrefillAppliedRef.current?.();
  }, [prefillNonce, prefillText]);

  // Курсор поля (TASK-300): от него зависит токен `@`/`/`. После подстановки из истории или списка курсор ставится явно.
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const pendingCaretRef = useRef<number | null>(null);
  const historyNavRef = useRef<HistoryNav>(HISTORY_START);
  const syncCaret = (el: HTMLTextAreaElement) => {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setCaret((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pos = pendingCaretRef.current;
    if (pos !== null) {
      pendingCaretRef.current = null;
      el.setSelectionRange(pos, pos);
    }
    syncCaret(el);
  }, [input]);
  const setInputAt = (text: string, caretPos: number) => {
    inputRef.current = text;
    pendingCaretRef.current = caretPos;
    setInput(text);
  };

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

  // Вложения (TASK-289): вставка из буфера, перетаскивание и скрепка. Файл сохраняется сразу, отправка ждёт сохранения.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canAttach = !!onSaveAttachment;
  const attachSaving = attachments.some((a) => !a.saved);
  const readyAttachments = attachments.flatMap((a) => (a.saved ? [a.saved] : []));

  const dropPending = (id: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const addFiles = (files: File[]) => {
    if (!onSaveAttachment || files.length === 0) return;
    const free = PROMPT_ATTACHMENT_MAX_COUNT - attachmentsRef.current.length;
    if (files.length > free) setAttachError(t.aiStudio.input.attachTooMany.replace('{count}', String(PROMPT_ATTACHMENT_MAX_COUNT)));
    else setAttachError(null);
    for (const file of files.slice(0, Math.max(0, free))) {
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const name = file.name || 'file';
      const mime = file.type || mimeFromName(name);
      const failed = (error: string) => {
        dropPending(id);
        setAttachError(t.aiStudio.input.attachFailed.replace('{name}', name).replace('{error}', error));
      };
      // Большая картинка уменьшается перед сохранением, поэтому предел размера — для прочих файлов.
      if (file.size > PROMPT_ATTACHMENT_MAX_BYTES && !isPreviewableImage(mime)) {
        setAttachError(
          t.aiStudio.input.attachFailed.replace('{name}', name).replace('{error}', formatAttachmentSize(file.size))
        );
        continue;
      }
      const previewUrl = isPreviewableImage(mime) ? URL.createObjectURL(file) : undefined;
      setAttachments((prev) => [...prev, { id, name, mime, size: file.size, ...(previewUrl ? { previewUrl } : {}) }]);
      void attachmentPayload(file)
        .then((payload) => onSaveAttachment({ name: payload.name, mime: payload.mime, data: payload.data }))
        .then((saved) => {
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, saved, name: saved.name, size: saved.size } : a)));
        })
        .catch((err: unknown) => failed(ipcErrorText(err)));
    }
  };

  const clearAttachments = () => {
    for (const a of attachmentsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAttachments([]);
    setAttachError(null);
  };

  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    []
  );

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    // Снимок экрана или скопированный файл; если в буфере есть и текст (Word, браузер), вставляется текст.
    if (e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    addFiles(files);
  };

  const hasFiles = (e: React.DragEvent) => canAttach && Array.from(e.dataTransfer.types).includes('Files');

  // Во время ответа сообщение не теряется, а встаёт в очередь вкладки (TASK-273).
  const sendText = (text: string): boolean => {
    const textToSend = text.trim();
    // Пока вложение сохраняется, отправка ждёт: иначе промпт ушёл бы без картинки.
    if (attachSaving) return false;
    const files = readyAttachments;
    if (!textToSend && files.length === 0) return false;
    inputRef.current = '';
    historyNavRef.current = HISTORY_START;
    setInput('');

    if (files.length === 0 && (textToSend.toLowerCase() === '/usage' || textToSend.toLowerCase() === '/cost')) {
      window.dispatchEvent(new CustomEvent('projecthub:open-claude-usage'));
      return true;
    }

    clearAttachments();
    onSend(textToSend, files);
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

  // Esc как в терминальном Claude Code (TASK-299): во время хода — прервать, Esc Esc при пустом поле — откат.
  // Слушатель на window в фазе захвата: он видит окна и меню ещё открытыми, до того как их Esc их закроет.
  const [escArmed, setEscArmed] = useState(false);
  const escArmedAtRef = useRef<number | null>(null);
  const escStateRef = useRef({ isStreaming, canRewind, escapeBlocked, promptDictation, onAbort, onRewind });
  useEffect(() => {
    escStateRef.current = { isStreaming, canRewind, escapeBlocked, promptDictation, onAbort, onRewind };
  });
  useEffect(() => {
    if (!escArmed) return;
    const timer = setTimeout(() => {
      escArmedAtRef.current = null;
      setEscArmed(false);
    }, STUDIO_ESC_DOUBLE_MS);
    return () => clearTimeout(timer);
  }, [escArmed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainEscape(e)) return;
      const field = textareaRef.current;
      // Studio скрыта (другой раздел) — поле не видно, Esc не его.
      if (!field || field.offsetParent === null) return;
      const s = escStateRef.current;
      if (s.escapeBlocked || s.promptDictation || hasEscOverlay(document)) return;
      // Esc из другого поля ввода (переименование вкладки и т.п.) или вне Studio принадлежит ему.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && target !== field && target !== document.body) {
        const root = field.closest('[data-studio-root]');
        if (!root?.contains(target)) return;
        if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      }
      const action = studioEscAction({
        streaming: s.isStreaming,
        inputEmpty: !inputRef.current.trim() && attachmentsRef.current.length === 0,
        canRewind: s.canRewind && !!s.onRewind,
        armedAt: escArmedAtRef.current,
        now: Date.now()
      });
      if (action === 'none') return;
      e.preventDefault();
      if (action === 'abort') {
        escArmedAtRef.current = null;
        setEscArmed(false);
        s.onAbort();
      } else if (action === 'arm') {
        escArmedAtRef.current = Date.now();
        setEscArmed(true);
      } else {
        escArmedAtRef.current = null;
        setEscArmed(false);
        // Окно отката монтируется синхронно и вешает свой Esc на window: открытое в этом же событии, оно получило бы
        // этот Esc в фазе всплытия и сразу закрылось.
        const open = s.onRewind;
        setTimeout(() => open?.(), 0);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Автодополнение (TASK-300, decision-214): `/команда` в начале поля и `@путь` после пробела.
  const composerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [fileResult, setFileResult] = useState<{ entries: Array<{ path: string; dir: boolean }>; truncated: boolean } | null>(null);
  const [cliList, setCliList] = useState<CliCommandList | null | undefined>(undefined);
  const [cliLoading, setCliLoading] = useState(false);

  const token = completion ? completionToken(input, caret.start, caret.end) : null;
  const tokenKey = token ? `${token.kind}:${token.start}` : null;
  const suggestOpen = !!token && focused && tokenKey !== dismissed;
  const slashOpen = suggestOpen && token?.kind === 'slash';
  const mentionOpen = suggestOpen && token?.kind === 'mention';
  const mentionQuery = mentionOpen ? token.query : null;

  useEffect(() => {
    if (!tokenKey) setDismissed(null);
  }, [tokenKey]);
  useEffect(() => {
    setActive(0);
  }, [tokenKey, token?.query]);

  useEffect(() => {
    if (!slashOpen || !completion?.cliTab) return;
    let alive = true;
    const known = completion.peekCliCommands();
    setCliList(known);
    setCliLoading(true);
    void completion.loadCliCommands().then((list) => {
      if (!alive) return;
      setCliList(list);
      setCliLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [slashOpen, completion]);

  useEffect(() => {
    if (mentionQuery === null || !completion) {
      setFileResult(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(
      () => {
        completion
          .searchFiles(mentionQuery)
          .then((result) => alive && setFileResult(result))
          .catch(() => alive && setFileResult({ entries: [], truncated: false }));
      },
      mentionQuery ? 80 : 0
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mentionQuery, completion]);

  const cliText = studioCliText(language);
  const groupLabel = { studio: t.aiStudio.input.suggestGroupStudio, cli: t.aiStudio.input.suggestGroupCli, terminal: t.aiStudio.input.suggestGroupTerminal };
  const slashItems =
    slashOpen && token
      ? slashSuggestions({
          cliTab: !!completion?.cliTab,
          studioDescription: (name) => cliText.helpCommand[name],
          cliCommands: cliList?.commands ?? [],
          query: token.query
        })
      : [];
  const fileEntries = mentionOpen ? fileResult?.entries ?? [] : [];
  const suggestionItems: ComposerSuggestionItem[] = slashOpen
    ? slashItems.map((s) => ({
        key: `${s.group}:${s.name}`,
        label: `/${s.name}`,
        hint: s.argumentHint,
        detail: s.description,
        badge: groupLabel[s.group]
      }))
    : fileEntries.map((f) => {
        const trimmed = f.dir ? f.path.slice(0, -1) : f.path;
        const base = trimmed.slice(trimmed.lastIndexOf('/') + 1) + (f.dir ? '/' : '');
        return {
          key: f.path,
          label: f.path,
          strong: base,
          icon: f.dir ? <Folder className="w-3.5 h-3.5 text-amber-300/80" /> : <FileIcon className="w-3.5 h-3.5" />
        };
      });
  let suggestStatus: string | undefined;
  if (slashOpen) {
    if (completion?.cliTab && cliLoading && cliList === undefined) suggestStatus = t.aiStudio.input.suggestCliLoading;
    else if (slashItems.length === 0) suggestStatus = t.aiStudio.input.suggestNoCommands;
  } else if (mentionOpen) {
    if (!fileResult) suggestStatus = t.aiStudio.input.suggestSearching;
    else if (fileEntries.length === 0) suggestStatus = t.aiStudio.input.suggestNoFiles;
  }

  /**
   * Подставить пункт списка. Enter у команды без аргументов или у уже набранной целиком сразу отправляет её, как в
   * терминальном Claude Code; у команды с аргументами — вставляет её с пробелом.
   */
  const pickSuggestion = (index: number, how: 'tab' | 'enter' | 'click') => {
    if (!token) return;
    if (token.kind === 'slash') {
      const s = slashItems[index];
      if (!s) return;
      const applied = applyCompletion(inputRef.current, token, `/${s.name}`);
      if (how === 'enter' && (!s.argumentHint || token.query.toLowerCase() === s.name.toLowerCase())) {
        sendText(applied.text);
        return;
      }
      setInputAt(applied.text, applied.caret);
    } else {
      const f = fileEntries[index];
      if (!f) return;
      const applied = applyCompletion(inputRef.current, token, mentionText(f.path), f.dir);
      setInputAt(applied.text, applied.caret);
    }
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Набор через IME (иероглифы, японская раскладка) — клавиши его.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mods = e.ctrlKey || e.altKey || e.metaKey;
    if (suggestOpen && !mods) {
      const count = suggestionItems.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey && count > 0) {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey && count > 0) {
        e.preventDefault();
        pickSuggestion(active, 'tab');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && count > 0) {
        e.preventDefault();
        pickSuggestion(active, 'enter');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(tokenKey);
        return;
      }
    }
    // История промптов (TASK-300): ↑ с первой строки, ↓ с последней; набранный черновик возвращается ↓.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mods && !e.shiftKey && getHistory) {
      const el = e.currentTarget;
      const up = e.key === 'ArrowUp';
      const atEdge = up ? caretOnFirstLine(input, el.selectionStart, el.selectionEnd) : caretOnLastLine(input, el.selectionStart, el.selectionEnd);
      const step = atEdge ? historyStep(historyNavRef.current, getHistory(), up ? 'up' : 'down', input) : null;
      if (step) {
        e.preventDefault();
        historyNavRef.current = step.nav;
        setInputAt(step.text, step.text.length);
        return;
      }
    }
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
      onSelect: () => onSend(t.aiStudio.quickActions.nextTaskPrompt, [])
    },
    {
      key: 'commit',
      label: t.aiStudio.quickActions.commit,
      hint: t.aiStudio.quickActions.commitPrompt,
      icon: <GitCommit className="w-3.5 h-3.5 text-emerald-400" />,
      onSelect: () => onSend(t.aiStudio.quickActions.commitPrompt, [])
    },
    {
      key: 'deploy',
      label: t.aiStudio.quickActions.deploy,
      hint: t.aiStudio.quickActions.deployPrompt,
      icon: <Rocket className="w-3.5 h-3.5 text-purple-400" />,
      onSelect: () => onSend(t.aiStudio.quickActions.deployPrompt, [])
    },
    {
      key: 'adr',
      label: t.aiStudio.promptCards.adrCreate,
      hint: t.aiStudio.promptCards.adrCreateDesc,
      icon: <Landmark className="w-3.5 h-3.5 text-slate-400" />,
      onSelect: () => onSend(t.aiStudio.promptCards.adrCreatePrompt, [])
    }
  ];

  return (
    <div className="px-4 pt-2 pb-3 bg-ph-elevated border-t border-slate-800 shrink-0">
      {/*
        Поле ввода с нижней строкой (TASK-169): агент вкладки, режим, вставка контекста и быстрые команды —
        слева, авто-подтверждение, микрофон и отправка — справа. Отдельных строк над полем нет.
      */}
      <div
        className={`relative bg-ph-hover border rounded-2xl px-2.5 pt-2 pb-1.5 shadow-inner focus-within:border-indigo-500 transition ${
          dragOver ? 'border-indigo-400 ring-2 ring-indigo-500/30' : 'border-slate-700/80'
        }`}
        ref={composerRef}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragOver(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
        data-testid="composer"
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-indigo-950/80 text-xs text-indigo-100 pointer-events-none">
            <Paperclip className="w-4 h-4 mr-1.5" />
            {t.aiStudio.input.attachDrop}
          </div>
        )}

        {/* Вложения промпта (TASK-289) */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-1.5" data-testid="composer-attachments">
            {attachments.map((a) => (
              <div
                key={a.id}
                className={`group relative flex items-center gap-1.5 rounded-lg border border-slate-600/80 bg-ph-raised text-[11px] text-slate-200 ${
                  a.previewUrl ? 'p-0.5' : 'px-2 py-1'
                } ${a.saved ? '' : 'opacity-60'}`}
                title={a.saved ? `${a.name} · ${formatAttachmentSize(a.size)}` : t.aiStudio.input.attachSaving}
                data-testid="composer-attachment"
                data-saved={a.saved ? 'true' : 'false'}
              >
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.name} className="h-12 w-12 rounded-md object-cover" />
                ) : (
                  <>
                    <FileIcon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                    <span className="max-w-[10rem] truncate">{a.name}</span>
                    <span className="text-slate-500 shrink-0">{formatAttachmentSize(a.size)}</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => dropPending(a.id)}
                  className={`${
                    a.previewUrl ? 'absolute -top-1.5 -right-1.5 rounded-full bg-slate-800 border border-slate-600 p-0.5' : ''
                  } text-slate-400 hover:text-red-300`}
                  title={t.aiStudio.input.attachRemove}
                  aria-label={t.aiStudio.input.attachRemove}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachError && (
          <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] text-red-300" data-testid="composer-attach-error">
            <span className="flex-1 truncate" title={attachError}>{attachError}</span>
            <button type="button" onClick={() => setAttachError(null)} className="text-slate-500 hover:text-slate-300" aria-label={t.aiStudio.input.attachRemove}>
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {suggestOpen && (suggestionItems.length > 0 || suggestStatus) && (
          <ComposerSuggestions
            anchor={composerRef.current}
            heading={slashOpen ? t.aiStudio.input.suggestCommands : t.aiStudio.input.suggestFiles}
            items={suggestionItems}
            active={active}
            {...(suggestStatus ? { status: suggestStatus } : {})}
            {...(mentionOpen && fileResult?.truncated
              ? { note: t.aiStudio.input.suggestTruncated.replace('{count}', FILE_INDEX_LIMIT.toLocaleString(language)) }
              : {})}
            footer={t.aiStudio.input.suggestHint}
            onPick={(i) => pickSuggestion(i, 'click')}
            onHover={setActive}
            testId={slashOpen ? 'composer-slash-suggestions' : 'composer-file-suggestions'}
          />
        )}

        {escArmed && (
          <div className="px-1.5 pb-1 text-[11px] text-slate-400" data-testid="composer-esc-hint">
            {t.aiStudio.input.escAgainRewind}
          </div>
        )}

        <textarea
          onPaste={handlePaste}
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
            inputRef.current = e.target.value;
            setInput(e.target.value);
            syncCaret(e.target);
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          aria-autocomplete="list"
          aria-expanded={suggestOpen}
          data-testid="composer-input"
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
            {canAttach && (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-300 hover:bg-ph-raised transition shrink-0"
                  title={t.aiStudio.input.attach}
                  aria-label={t.aiStudio.input.attach}
                  data-testid="composer-attach"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  data-testid="composer-attach-input"
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
              </>
            )}
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
              {(input.trim() || readyAttachments.length > 0) && (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={attachSaving}
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
                title={`${t.aiStudio.input.stop} (Esc)`}
                data-testid="composer-stop"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>{t.aiStudio.input.stop}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={attachSaving || (!input.trim() && readyAttachments.length === 0)}
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
