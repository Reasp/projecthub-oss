import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sparkles,
  Folder,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  Loader2,
  ShieldAlert,
  Copy,
  Check,
  Layers,
  GitBranch,
  ListTodo,
  BookOpen,
  ScrollText,
  Server,
  Package,
  Terminal,
  ChevronDown,
  ChevronRight
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useTranslation } from '../../i18n/useTranslation';
import type {
  InitAction,
  InitGroup,
  InitPlanItem,
  InitPreview,
  InitProgressEvent,
  InitReason,
  InitReport,
  InitRequest,
  TemplateEntry
} from '../../types/projectInit';
import { TemplatesModal } from './TemplatesModal';
import { InitDiffView } from './InitDiffView';

/** `update` — обновление существующего проекта из новой версии шаблона (TASK-156). */
export type ProjectInitMode = 'existing' | 'new' | 'folder' | 'update';

interface ProjectInitModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: ProjectInitMode;
  /** Проект для режима `existing`. */
  projectPath?: string;
  /** Папка для режима `folder`, если уже выбрана в системном диалоге. */
  initialFolder?: string;
}

type Step = 'setup' | 'preview' | 'applying' | 'done';

const RULE_TARGET_OPTIONS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.agents/rules/projecthub.md'];
const DEFAULT_RULE_TARGETS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const GROUP_ORDER: InitGroup[] = ['git', 'tasks', 'docs', 'rules', 'mcp', 'template'];

const GROUP_ICON: Record<InitGroup, React.FC<{ className?: string }>> = {
  git: GitBranch,
  tasks: ListTodo,
  docs: BookOpen,
  rules: ScrollText,
  mcp: Server,
  template: Package
};

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** Команда коммита по записанным путям: верхние каталоги и файлы, без `git add -A`. */
function commitCommand(report: InitReport, message: string): string {
  const tops = [...new Set(report.written.map((w) => w.path.replace(/\/$/, '').split('/')[0]).filter((p) => p && p !== '.git'))];
  const quoted = tops.map((p) => (/[\s"]/.test(p) ? `"${p}"` : p)).join(' ');
  return `git add ${quoted} && git commit -m "${message}"`;
}

export const ProjectInitModal: React.FC<ProjectInitModalProps> = ({ isOpen, onClose, mode, projectPath, initialFolder }) => {
  const { t, language } = useTranslation();
  const { fetchProjects, selectProject, refreshSingleProject, setActiveTab } = useProjectStore();
  const ti = t.init;
  // Селектор возвращает сам overview: `?? []` в селекторе давал бы новый массив на каждый вызов и бесконечный ререндер.
  const claudeOverview = useClaudeAccountsStore((s) => s.overview);
  const claudeAccounts = claudeOverview?.accounts ?? [];
  const refreshClaudeAccounts = useClaudeAccountsStore((s) => s.refresh);
  const setProjectClaudeAccount = useClaudeAccountsStore((s) => s.setProjectAccount);

  const [step, setStep] = useState<Step>('setup');
  const [projectName, setProjectName] = useState('');
  const [parentDir, setParentDir] = useState(
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Win') ? 'C:\\Projects' : ''
  );
  const [folder, setFolder] = useState<string | null>(initialFolder ?? null);
  const [rulesTargets, setRulesTargets] = useState<string[]>(DEFAULT_RULE_TARGETS);
  const [rulesMode, setRulesMode] = useState<'append' | 'replace'>('append');
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(mode === 'new' ? 'builtin' : null);
  const [placement, setPlacement] = useState<'root' | 'subfolder' | undefined>(undefined);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [sets, setSets] = useState<Record<string, boolean>>({});
  const [gitHooks, setGitHooks] = useState<boolean | undefined>(undefined);
  const [commands, setCommands] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<InitPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, InitAction>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  const [rememberTrust, setRememberTrust] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<InitReport | null>(null);
  const [copied, setCopied] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Аккаунт Claude Code проекта (decision-87 п. 4): '' — без привязки, профиль по умолчанию.
  const [claudeAccountId, setClaudeAccountId] = useState('');
  const [initialClaudeAccountId, setInitialClaudeAccountId] = useState('');
  const [accountWarning, setAccountWarning] = useState<string | null>(null);
  // Режим обновления: настройки шаблона из lock-файла; предпросмотр — только после них.
  const [updateReady, setUpdateReady] = useState(mode !== 'update');
  const requestSeq = useRef(0);
  const logRef = useRef<HTMLPreElement | null>(null);

  const targetDir = useMemo(() => {
    if (mode === 'existing' || mode === 'update') return projectPath ?? '';
    if (mode === 'folder') return folder ?? '';
    return projectName.trim() && parentDir.trim() ? joinPath(parentDir.trim(), projectName.trim()) : '';
  }, [mode, projectPath, folder, projectName, parentDir]);

  const loadTemplates = async () => {
    const res = await window.api.templatesList(language);
    if (res.ok) setTemplates(res.value);
  };

  useEffect(() => {
    if (!isOpen) return;
    setStep('setup');
    setError(null);
    setPreview(null);
    setChoices({});
    setReport(null);
    setLog([]);
    setTrustConfirmed(false);
    setRememberTrust(false);
    setFolder(initialFolder ?? null);
    setTemplateId(mode === 'new' ? 'builtin' : null);
    setPlacement(undefined);
    setFeatures({});
    setSets({});
    setCommands({});
    setGitHooks(undefined);
    setClaudeAccountId('');
    setInitialClaudeAccountId('');
    setAccountWarning(null);
    setUpdateReady(mode !== 'update');
    if (mode === 'update' && projectPath) {
      void window.api.initTemplateStatus(projectPath, language).then((res) => {
        if (res.ok) {
          const status = res.value;
          setTemplateId(status.templateId ?? 'builtin');
          if (status.placement) setPlacement(status.placement);
          setFeatures(status.features);
          setSets(status.sets);
          if (status.gitHooks !== undefined) setGitHooks(status.gitHooks);
        } else {
          setTemplateId('builtin');
          setError(res.error);
        }
        setUpdateReady(true);
      });
    }
    void loadTemplates();
    void refreshClaudeAccounts();
    // У существующего проекта показываем его текущую привязку.
    if ((mode === 'existing' || mode === 'update') && projectPath && window.api?.claudeAccounts) {
      void window.api.claudeAccounts
        .forProject(projectPath)
        .then((resolved) => {
          const bound = resolved?.source === 'project' ? resolved.account.id : '';
          setClaudeAccountId(bound);
          setInitialClaudeAccountId(bound);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сброс только при открытии окна
  }, [isOpen, mode, projectPath, initialFolder]);

  const request = useMemo<InitRequest>(
    () => ({
      targetDir,
      projectName: mode === 'new' ? projectName.trim() : undefined,
      locale: language === 'en' ? 'en' : 'ru',
      rulesMode,
      rulesTargets,
      templateId,
      placement,
      features,
      sets,
      commands,
      gitHooks
    }),
    [targetDir, mode, projectName, language, rulesMode, rulesTargets, templateId, placement, features, sets, commands, gitHooks]
  );

  // Предпросмотр пересчитывается при каждом изменении настроек: по нему окно знает фичи шаблона и что уже есть.
  useEffect(() => {
    if (!isOpen || step !== 'setup' || !targetDir || !updateReady) {
      if (!targetDir) setPreview(null);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const res = await window.api.initPreview(request);
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (res.ok) {
        setPreview(res.value);
        setError(null);
      } else {
        setPreview(null);
        setError(res.error);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [isOpen, step, request, targetDir, updateReady]);

  useEffect(() => {
    if (!isOpen) return;
    return window.api.onInitProgress((event: InitProgressEvent) => {
      setLog((prev) => {
        const next = [...prev];
        if (event.type === 'file') next.push(`${event.action.padEnd(8)} ${event.path}`);
        else if (event.type === 'command-start') next.push(`\n$ ${event.run}  (${event.cwd})`);
        else if (event.type === 'command-output') next.push(event.text.replace(/\s+$/, ''));
        else next.push(event.ok ? '✓' : `✗ exit ${event.exitCode ?? '?'}`);
        return next.slice(-2000);
      });
    });
  }, [isOpen]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!isOpen) return null;

  const items = preview?.items ?? [];
  const actionOf = (item: InitPlanItem): InitAction => choices[item.id] ?? item.action;
  const changes = items.filter((item) => actionOf(item) !== 'skip');
  const tpl = preview?.template ?? null;
  const needsTrust = Boolean(tpl?.requiresConfirmation);

  const actionLabel = (action: InitAction, item?: InitPlanItem) =>
    item?.kind === 'command' && action === 'create'
      ? ti.actionRun
      : { create: ti.actionCreate, append: ti.actionAppend, merge: ti.actionMerge, replace: ti.actionReplace, delete: ti.actionDelete, skip: ti.actionSkip }[action];

  const reasonLabel = (reason: InitReason, detail?: string): string => {
    const map: Record<InitReason, string> = {
      missing: ti.reasonMissing,
      exists: ti.reasonExists,
      'up-to-date': ti.reasonUpToDate,
      'lines-missing': ti.reasonLinesMissing,
      'section-missing': ti.reasonSectionMissing,
      'section-outdated': ti.reasonSectionOutdated,
      'statuses-missing': ti.reasonStatusesMissing.replace('{detail}', detail ?? ''),
      'config-unreadable': ti.reasonConfigUnreadable,
      'docs-exist': ti.reasonDocsExist,
      'not-json': ti.reasonNotJson,
      'template-file': ti.reasonTemplateFile,
      'template-changed': ti.reasonTemplateChanged,
      'template-updated': ti.reasonTemplateUpdated,
      'user-modified': ti.reasonUserModified,
      conflict: ti.reasonConflict,
      'user-deleted': ti.reasonUserDeleted,
      'template-removed': ti.reasonTemplateRemoved,
      'hooks-conflict': ti.reasonHooksConflict,
      'feature-off': ti.reasonFeatureOff,
      'entry-missing': ti.reasonEntryMissing
    };
    return map[reason];
  };

  const groupLabel: Record<InitGroup, string> = {
    git: ti.groupGit,
    tasks: ti.groupTasks,
    docs: ti.groupDocs,
    rules: ti.groupRules,
    mcp: ti.groupMcp,
    template: ti.groupTemplate
  };

  // Часть основы «есть», если на месте её ключевые файлы; недостающие строки .gitignore или секции её не отменяют.
  const reasonOf = (id: string) => items.find((item) => item.id === id)?.reason;
  const partPresent = (group: InitGroup): boolean => {
    if (group === 'git') return reasonOf('git:init') === 'exists';
    if (group === 'tasks') return reasonOf('tasks:config') !== 'missing' && reasonOf('dir:backlog/tasks') === 'exists';
    if (group === 'docs') return reasonOf('dir:backlog/docs') === 'exists' && reasonOf('dir:backlog/decisions') === 'exists';
    return items.some((item) => item.group === 'rules' && (item.reason === 'up-to-date' || item.reason === 'section-outdated'));
  };

  const foundationParts: Array<{ group: InitGroup; label: string }> = [
    { group: 'git', label: ti.partGit },
    { group: 'tasks', label: ti.partTasks },
    { group: 'docs', label: ti.partDocs },
    { group: 'rules', label: ti.partRules }
  ];

  const handleChooseFolder = async () => {
    const picked = await window.api.initSelectFolder();
    if (picked) setFolder(picked);
  };

  const handleChooseParent = async () => {
    const picked = await window.api.selectDirectory();
    if (picked) setParentDir(picked);
  };

  const goPreview = () => {
    if (mode === 'new' && !projectName.trim()) {
      setError(ti.nameRequired);
      return;
    }
    if (!preview) return;
    setError(null);
    setChoices({});
    setStep('preview');
  };

  const handleApply = async () => {
    if (!preview) return;
    setStep('applying');
    setLog([]);
    setError(null);
    if (needsTrust && rememberTrust && tpl) {
      await window.api.templatesSetTrusted(tpl.entry.id, true);
    }
    const res = await window.api.initApply({
      ...request,
      choices,
      confirmTemplateHash: needsTrust && trustConfirmed ? tpl?.entry.hash : undefined
    });
    if (!res.ok) {
      setError(res.error);
      setStep('preview');
      return;
    }
    setReport(res.value);
    setStep('done');
    await fetchProjects();
    await refreshSingleProject(res.value.projectPath);
    // Привязка к аккаунту — после регистрации проекта: IPC принимает только зарегистрированный путь.
    if (claudeAccountId !== initialClaudeAccountId) {
      try {
        await setProjectClaudeAccount(res.value.projectPath, claudeAccountId || null);
      } catch (err) {
        setAccountWarning(ti.claudeAccountFailed.replace('{error}', err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const handleOpenProject = () => {
    if (!report) return;
    const project = useProjectStore.getState().projects.find((p) => p.path === report.projectPath);
    if (project) {
      selectProject(project);
      setActiveTab('kanban');
    }
    onClose();
  };

  const commitMessage =
    mode === 'update'
      ? language === 'en' ? 'chore: update ProjectHub template' : 'chore: обновление шаблона ProjectHub'
      : language === 'en' ? 'chore: initialize ProjectHub' : 'chore: инициализация ProjectHub';
  const commitText = report ? commitCommand(report, commitMessage) : '';

  const title = mode === 'new' ? ti.titleNew : mode === 'folder' ? ti.titleFolder : mode === 'update' ? ti.titleUpdate : ti.titleExisting;
  const conflicts = items.filter((item) => item.reason === 'conflict').length;
  const diffLabels = { tooLarge: ti.diffTooLarge, same: ti.diffSame, gap: ti.diffGap };

  // Что станет с файлом при действии, которое пишет: для пункта «пропустить» — при первом пишущем варианте.
  const nextText = (item: InitPlanItem, action: InitAction): string | null | undefined => {
    const writing = action !== 'skip' ? action : item.options.find((option) => option !== 'skip');
    if (!writing) return undefined;
    if (writing === 'delete') return '';
    return item.contents?.[writing] ?? (item.copyFrom ? item.compare?.template : undefined);
  };
  const templateNext = (item: InitPlanItem): string | null | undefined =>
    item.contents?.replace ?? item.contents?.create ?? (item.copyFrom ? item.compare?.template : undefined);

  // Строка о версии шаблона: обновление по lock-файлу или повторная инициализация без него.
  const updateBanner = (() => {
    if (!tpl) return null;
    if (tpl.applied) {
      return tpl.applied.changed
        ? ti.updateFrom.replace('{name}', tpl.entry.name).replace('{from}', tpl.applied.version || '?').replace('{to}', tpl.entry.version || '?')
        : ti.updateSame.replace('{version}', tpl.applied.version || '?');
    }
    return mode === 'update' ? ti.updateNoLock : null;
  })();
  const stepIndex = { setup: 1, preview: 2, applying: 3, done: 3 }[step];
  const stepName = { setup: ti.stepSetup, preview: ti.stepPreview, applying: ti.stepApply, done: ti.stepDone }[step];
  const busy = step === 'applying';
  const chosenAccountName = claudeAccountId ? claudeAccounts.find((a) => a.id === claudeAccountId)?.name ?? null : null;

  const toggle = (setter: React.Dispatch<React.SetStateAction<Record<string, boolean>>>, id: string, current: boolean) =>
    setter((prev) => ({ ...prev, [id]: !current }));

  const card = 'p-3 rounded-xl bg-ph-hover/60 border border-slate-800';
  const optionRow = (active: boolean) =>
    `p-2.5 rounded-lg border transition cursor-pointer flex items-start gap-2.5 ${
      active ? 'bg-indigo-600/10 border-indigo-500/40' : 'bg-ph-hover/40 border-slate-800 hover:border-slate-700'
    }`;

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150">
      <div className="bg-ph-elevated border border-slate-700 rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-ph-raised flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-amber-300" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">{title}</h2>
              <p className="text-xs text-slate-400">
                {ti.step} {stepIndex} / 3 · {stepName}
              </p>
            </div>
          </div>
          {!busy && (
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" aria-label={t.common.close}>
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs">
          {error && (
            <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/50 flex items-start gap-2.5 text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-px" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}

          {step === 'setup' && (
            <>
              {/* Папка */}
              <section className="space-y-2">
                <h3 className="font-medium text-slate-200 text-[11px]">{ti.location}</h3>
                {(mode === 'existing' || mode === 'update') && <div className={`${card} font-mono text-indigo-300 break-all`}>{projectPath}</div>}
                {mode === 'update' && updateBanner && (
                  <div className="text-[11px] text-sky-300" data-testid="init-update-banner">
                    {updateBanner}
                  </div>
                )}
                {mode === 'folder' && (
                  <div className="flex items-center gap-2">
                    <div className={`${card} flex-1 font-mono break-all ${folder ? 'text-indigo-300' : 'text-slate-500'}`}>{folder ?? ti.folderNotChosen}</div>
                    <button type="button" onClick={handleChooseFolder} className="ph-btn ph-btn-secondary shrink-0">
                      <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                      {ti.chooseFolder}
                    </button>
                  </div>
                )}
                {mode === 'new' && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      autoFocus
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder={ti.projectNamePlaceholder}
                      aria-label={ti.projectName}
                      className="w-full bg-ph-hover border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={parentDir}
                        onChange={(e) => setParentDir(e.target.value)}
                        aria-label={ti.parentDirectory}
                        className="flex-1 bg-ph-hover border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-300 font-mono focus:outline-none focus:border-indigo-500"
                      />
                      <button type="button" onClick={handleChooseParent} className="ph-btn ph-btn-secondary shrink-0">
                        <Folder className="w-3.5 h-3.5 text-indigo-400" />
                        {ti.chooseFolder}
                      </button>
                    </div>
                    {targetDir && (
                      <div className="text-[11px] text-slate-500">
                        {ti.resultingPath}: <span className="font-mono text-indigo-300 break-all">{targetDir}</span>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Основа */}
              <section className="space-y-2">
                <div>
                  <h3 className="font-medium text-slate-200 text-[11px]">{ti.foundation}</h3>
                  <p className="text-[11px] text-slate-400">{ti.foundationDesc}</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {foundationParts.map(({ group, label }) => {
                    const present = preview !== null && partPresent(group);
                    const Icon = GROUP_ICON[group];
                    return (
                      <div key={group} className={`${card} flex items-center gap-2`}>
                        <Icon className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        <span className="text-slate-200">{label}</span>
                        <span className={`ml-auto text-[10px] ${present ? 'text-emerald-400' : 'text-amber-300'}`}>
                          {preview ? (present ? ti.partPresent : ti.partMissing) : '…'}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className={`${card} space-y-2.5`}>
                  <div className="text-[11px] text-slate-300">{ti.rulesTargets}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {RULE_TARGET_OPTIONS.map((target) => (
                      <label key={target} className="flex items-center gap-1.5 cursor-pointer text-slate-300 font-mono">
                        <input
                          type="checkbox"
                          checked={rulesTargets.includes(target)}
                          onChange={() =>
                            setRulesTargets((prev) => (prev.includes(target) ? prev.filter((x) => x !== target) : [...prev, target]))
                          }
                          className="w-3.5 h-3.5 rounded"
                        />
                        {target}
                      </label>
                    ))}
                  </div>
                  <div className="text-[11px] text-slate-300 pt-1">{ti.rulesMode}</div>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(['append', 'replace'] as const).map((value) => (
                      <label key={value} className={optionRow(rulesMode === value)}>
                        <input type="radio" name="rulesMode" checked={rulesMode === value} onChange={() => setRulesMode(value)} className="mt-0.5" />
                        <span>
                          <span className="block text-slate-200 font-medium">{value === 'append' ? ti.rulesAppend : ti.rulesReplace}</span>
                          <span className="block text-[11px] text-slate-400">{value === 'append' ? ti.rulesAppendDesc : ti.rulesReplaceDesc}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </section>

              {/* Аккаунт Claude Code (decision-87 п. 4): выбор есть, только когда профилей больше одного */}
              {claudeAccounts.length > 1 && (
                <section className="space-y-2">
                  <div>
                    <h3 className="font-medium text-slate-200 text-[11px]">{ti.claudeAccount}</h3>
                    <p className="text-[11px] text-slate-400">{ti.claudeAccountDesc}</p>
                  </div>
                  <select
                    value={claudeAccountId}
                    onChange={(e) => setClaudeAccountId(e.target.value)}
                    data-testid="init-claude-account"
                    aria-label={ti.claudeAccount}
                    className="w-full bg-ph-hover border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">{ti.claudeAccountDefault}</option>
                    {/* Профиль `default` — то же, что «без привязки»: сервис не хранит привязку к нему. */}
                    {claudeAccounts
                      .filter((account) => account.id !== 'default')
                      .map((account) => (
                        <option key={account.id} value={account.id}>{account.name}</option>
                      ))}
                  </select>
                </section>
              )}

              {/* Шаблон */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-slate-200 text-[11px]">{ti.template}</h3>
                  <button type="button" onClick={() => setTemplatesOpen(true)} className="text-[11px] text-indigo-400 hover:text-indigo-300">
                    {ti.templateManage}
                  </button>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <label className={optionRow(templateId === null)}>
                    <input type="radio" name="template" checked={templateId === null} onChange={() => setTemplateId(null)} className="mt-0.5" />
                    <span>
                      <span className="block text-slate-200 font-medium">{ti.templateNone}</span>
                      <span className="block text-[11px] text-slate-400">{ti.templateNoneDesc}</span>
                    </span>
                  </label>
                  {templates.map((entry) => (
                    <label key={entry.id} className={optionRow(templateId === entry.id)}>
                      <input
                        type="radio"
                        name="template"
                        checked={templateId === entry.id}
                        disabled={entry.issues.length > 0}
                        onChange={() => {
                          setTemplateId(entry.id);
                          setFeatures({});
                          setSets({});
                          setCommands({});
                          setGitHooks(undefined);
                          setPlacement(undefined);
                        }}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-slate-200 font-medium truncate">
                          {entry.name} {entry.version && <span className="text-slate-500 font-normal">{entry.version}</span>}
                        </span>
                        <span className="flex flex-wrap gap-1 mt-0.5">
                          {entry.builtin && <span className="px-1.5 py-px rounded bg-slate-800/80text-[10px] text-emerald-300">{ti.templateBuiltin}</span>}
                          {!entry.trusted && <span className="px-1.5 py-px rounded bg-slate-800/80text-[10px] text-amber-300">{ti.templateUntrusted}</span>}
                          {entry.compat && <span className="px-1.5 py-px rounded bg-slate-800/80text-[10px] text-slate-400">{ti.templateCompat}</span>}
                          {entry.issues.length > 0 && <span className="px-1.5 py-px rounded bg-slate-800/80text-[10px] text-rose-300">{ti.templateIssues}</span>}
                        </span>
                        {entry.description && <span className="block text-[11px] text-slate-400 mt-1 line-clamp-2">{entry.description}</span>}
                      </span>
                    </label>
                  ))}
                </div>

                {tpl && (
                  <div className={`${card} space-y-3`}>
                    <div className="space-y-1.5">
                      <div className="text-[11px] text-slate-300">{ti.placement}</div>
                      <div className="grid sm:grid-cols-2 gap-2">
                        <label className={optionRow(tpl.placement === 'subfolder')}>
                          <input type="radio" name="placement" checked={tpl.placement === 'subfolder'} onChange={() => setPlacement('subfolder')} className="mt-0.5" />
                          <span>
                            <span className="block text-slate-200 font-medium">{ti.placementSubfolder.replace('{dir}', '.projecthub/infra/')}</span>
                            <span className="block text-[11px] text-slate-400">{ti.placementSubfolderDesc}</span>
                          </span>
                        </label>
                        <label className={`${optionRow(tpl.placement === 'root')} ${!tpl.allowRoot && !preview?.isNew ? 'opacity-50' : ''}`}>
                          <input
                            type="radio"
                            name="placement"
                            checked={tpl.placement === 'root'}
                            disabled={!tpl.allowRoot && !preview?.isNew}
                            onChange={() => setPlacement('root')}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="block text-slate-200 font-medium">{ti.placementRoot}</span>
                            <span className="block text-[11px] text-slate-400">{ti.placementRootDesc}</span>
                          </span>
                        </label>
                      </div>
                    </div>

                    {tpl.features.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] text-slate-300">{ti.features}</div>
                        <div className="grid sm:grid-cols-2 gap-1.5">
                          {tpl.features.map((feature) => (
                            <label key={feature.id} className={optionRow(feature.enabled)} title={feature.description}>
                              <input type="checkbox" checked={feature.enabled} onChange={() => toggle(setFeatures, feature.id, feature.enabled)} className="mt-0.5 w-3.5 h-3.5" />
                              <span className="min-w-0">
                                <span className="block text-slate-200">
                                  {feature.label}
                                  {feature.heavy && <span className="ml-1.5 text-[10px] uppercase text-purple-300">{ti.heavy}</span>}
                                </span>
                                {feature.description && <span className="block text-[11px] text-slate-500 line-clamp-2">{feature.description}</span>}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {tpl.sets.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] text-slate-300">{ti.ruleSets}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                          {tpl.sets.map((set) => (
                            <label key={set.id} className="flex items-center gap-1.5 cursor-pointer text-slate-300" title={set.description}>
                              <input type="checkbox" checked={set.enabled} onChange={() => toggle(setSets, set.id, set.enabled)} className="w-3.5 h-3.5" />
                              {set.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {tpl.gitHooks.available && (
                      <label className="flex items-start gap-2 cursor-pointer text-slate-300" title={tpl.gitHooks.description}>
                        <input type="checkbox" checked={tpl.gitHooks.enabled} onChange={() => setGitHooks(!tpl.gitHooks.enabled)} className="mt-0.5 w-3.5 h-3.5" />
                        <span>
                          <span className="block">{ti.gitHooks}</span>
                          {tpl.gitHooks.conflict && (
                            <span className="block text-[11px] text-amber-300">{ti.gitHooksConflict.replace('{what}', tpl.gitHooks.conflict)}</span>
                          )}
                        </span>
                      </label>
                    )}
                  </div>
                )}
              </section>
            </>
          )}

          {step === 'preview' && preview && (
            <div className="space-y-4">
              <p className="text-[11px] text-slate-400">{ti.previewDesc}</p>
              {updateBanner && (
                <div className="p-3 rounded-xl bg-sky-950/30 border border-sky-800/50 text-sky-200 text-[11px] space-y-1" data-testid="init-update-banner">
                  <div>{updateBanner}</div>
                  {conflicts > 0 && <div className="text-amber-300">{ti.conflictsCount.replace('{count}', String(conflicts))}</div>}
                </div>
              )}
              {claudeAccountId !== initialClaudeAccountId && (
                <div className="text-[11px] text-slate-300">
                  {ti.claudeAccountBound.replace('{name}', chosenAccountName ?? ti.claudeAccountDefault)}
                </div>
              )}
              {changes.length === 0 && (
                <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/50 flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 className="w-4 h-4" />
                  {ti.nothingToDo}
                </div>
              )}
              {GROUP_ORDER.map((group) => {
                const groupItems = items.filter((item) => item.group === group);
                if (groupItems.length === 0) return null;
                const Icon = GROUP_ICON[group];
                return (
                  <section key={group} className="space-y-1">
                    <h3 className="font-medium text-slate-200 text-[11px] flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5 text-indigo-400" />
                      {groupLabel[group]}
                    </h3>
                    <div className="rounded-xl border border-slate-800 divide-y divide-slate-800/80 overflow-hidden">
                      {groupItems.map((item) => {
                        const action = actionOf(item);
                        const content = item.contents?.[action];
                        const compare = item.compare;
                        const expandable = content !== undefined || compare !== undefined;
                        const isOpenRow = expanded[item.id];
                        const projectAfter = compare ? nextText(item, action) : undefined;
                        const templateAfter = compare ? templateNext(item) : undefined;
                        return (
                          <div key={item.id} className={action === 'skip' ? 'bg-ph-hover/20' : 'bg-ph-hover/60'}>
                            <div className="flex items-center gap-2 px-3 py-2">
                              {expandable ? (
                                <button
                                  type="button"
                                  onClick={() => setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                                  className="text-slate-500 hover:text-slate-300"
                                  aria-label={isOpenRow ? ti.hideContent : ti.showContent}
                                >
                                  {isOpenRow ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                </button>
                              ) : item.kind === 'command' ? (
                                <Terminal className="w-3.5 h-3.5 text-slate-500" />
                              ) : (
                                <span className="w-3.5" />
                              )}
                              <span className={`font-mono truncate ${action === 'skip' ? 'text-slate-500' : 'text-slate-200'}`} title={item.path}>
                                {item.kind === 'command' && item.detail ? item.detail : item.path}
                              </span>
                              <span className={`text-[10px] shrink-0 ${item.reason === 'conflict' ? 'text-amber-300' : 'text-slate-500'}`}>{reasonLabel(item.reason, item.detail)}</span>
                              <span className="ml-auto shrink-0">
                                {item.options.length > 1 ? (
                                  <select
                                    value={action}
                                    onChange={(e) => setChoices((prev) => ({ ...prev, [item.id]: e.target.value as InitAction }))}
                                    className="bg-ph-raised border border-slate-700 rounded-md px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
                                  >
                                    {item.options.map((option) => (
                                      <option key={option} value={option}>
                                        {actionLabel(option, item)}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="text-[11px] text-slate-500">{actionLabel(action, item)}</span>
                                )}
                              </span>
                            </div>
                            {isOpenRow && compare && (
                              <div className="mx-3 mb-2 space-y-1.5">
                                {compare.binary ? (
                                  <div className="text-[11px] text-slate-500">{ti.diffBinary}</div>
                                ) : (
                                  <>
                                    {typeof compare.base === 'string' && typeof templateAfter === 'string' && (
                                      <InitDiffView title={ti.diffTemplate} before={compare.base} after={templateAfter} labels={diffLabels} />
                                    )}
                                    {typeof compare.current === 'string' && typeof projectAfter === 'string' && (
                                      <InitDiffView title={ti.diffProject} before={compare.current} after={projectAfter} labels={diffLabels} />
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {isOpenRow && !compare && content !== undefined && (
                              <pre className="mx-3 mb-2 p-2.5 rounded-lg bg-ph-base border border-slate-800 text-[11px] text-slate-300 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                                {content}
                              </pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}

              {needsTrust && tpl && (
                <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-800/50 space-y-2.5">
                  <div className="flex items-center gap-2 text-amber-300 font-medium">
                    <ShieldAlert className="w-4 h-4" />
                    {ti.trustTitle}
                  </div>
                  <p className="text-[11px] text-amber-200/80">{ti.trustDesc}</p>
                  {tpl.risks.commands.length > 0 && (
                    <div>
                      <div className="text-[11px] text-slate-300 mb-1">{ti.trustCommands}</div>
                      <ul className="font-mono text-[11px] text-slate-200 space-y-0.5">
                        {tpl.risks.commands.map((cmd) => (
                          <li key={cmd.id}>
                            $ {cmd.run} <span className="text-slate-500">({cmd.cwd})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {tpl.risks.mcpServers.length > 0 && (
                    <div>
                      <div className="text-[11px] text-slate-300 mb-1">{ti.trustMcp}</div>
                      <ul className="font-mono text-[11px] text-slate-200 space-y-0.5">
                        {tpl.risks.mcpServers.map((server) => (
                          <li key={server.name}>
                            {server.name}: {server.command} {server.args.join(' ')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {tpl.risks.gitHooks && <div className="text-[11px] text-slate-200">{ti.trustHooks}</div>}
                  <label className="flex items-center gap-2 cursor-pointer text-slate-200">
                    <input type="checkbox" checked={trustConfirmed} onChange={(e) => setTrustConfirmed(e.target.checked)} className="w-3.5 h-3.5" />
                    {ti.trustConfirm}
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-slate-400">
                    <input type="checkbox" checked={rememberTrust} onChange={(e) => setRememberTrust(e.target.checked)} disabled={!trustConfirmed} className="w-3.5 h-3.5" />
                    {ti.trustRemember}
                  </label>
                </div>
              )}
            </div>
          )}

          {(step === 'applying' || step === 'done') && (
            <div className="space-y-3">
              {step === 'applying' && (
                <div className="flex items-center gap-2 text-slate-300">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                  {ti.applying}
                </div>
              )}
              {report && (
                <div className="space-y-2">
                  <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/50 flex items-center gap-2 text-emerald-300">
                    <CheckCircle2 className="w-4 h-4" />
                    {ti.doneSummary.replace('{count}', String(report.written.length))}
                  </div>
                  {report.backupDir && <div className="text-[11px] text-slate-400 font-mono break-all">{ti.backupAt.replace('{path}', report.backupDir)}</div>}
                  {(chosenAccountName || claudeAccountId !== initialClaudeAccountId) && !accountWarning && (
                    <div className="text-[11px] text-emerald-300" data-testid="init-claude-account-done">
                      {ti.claudeAccountBound.replace('{name}', chosenAccountName ?? ti.claudeAccountDefault)}
                    </div>
                  )}
                  {accountWarning && <div className="text-[11px] text-amber-300">{accountWarning}</div>}
                  {report.commands.map((cmd) => (
                    <div key={cmd.id} className={`text-[11px] ${cmd.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {cmd.ok
                        ? ti.commandOk.replace('{cmd}', cmd.run)
                        : ti.commandFailed.replace('{cmd}', cmd.run).replace('{code}', String(cmd.exitCode ?? cmd.error ?? '?'))}
                    </div>
                  ))}
                  {report.written.length > 0 && (
                    <div className={`${card} space-y-1.5`}>
                      <div className="text-[11px] text-slate-300">{ti.commitHint}</div>
                      <div className="flex items-start gap-2">
                        <code className="flex-1 font-mono text-[11px] text-indigo-300 break-all">{commitText}</code>
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(commitText);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}
                          className="ph-btn ph-btn-secondary shrink-0"
                        >
                          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          {copied ? ti.copied : ti.copy}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {log.length > 0 && (
                <pre ref={logRef} className="p-3 rounded-xl bg-ph-base border border-slate-800 text-[11px] text-slate-400 max-h-72 overflow-auto whitespace-pre-wrap break-words">
                  {log.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            {step === 'preview' && (
              <button type="button" onClick={() => setStep('setup')} className="ph-btn ph-btn-secondary">
                <ArrowLeft className="w-3.5 h-3.5" />
                {ti.back}
              </button>
            )}
            {step === 'setup' && loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {step === 'setup' && preview && !loading && (
              <span>
                <Layers className="w-3.5 h-3.5 inline mr-1" />
                {ti.changesCount.replace('{count}', String(items.filter((i) => i.action !== 'skip').length))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step !== 'applying' && (
              <button type="button" onClick={onClose} className="ph-btn ph-btn-secondary">
                {step === 'done' ? t.common.close : t.common.cancel}
              </button>
            )}
            {step === 'setup' && (
              <button type="button" onClick={goPreview} disabled={!preview || loading} className="ph-btn ph-btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
                {ti.preview}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 'preview' && (
              <button
                type="button"
                onClick={handleApply}
                disabled={changes.length === 0 || (needsTrust && !trustConfirmed)}
                className="ph-btn ph-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                {ti.apply}
              </button>
            )}
            {step === 'done' && report && (
              <button type="button" onClick={handleOpenProject} className="ph-btn ph-btn-primary">
                {ti.openProject}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      <TemplatesModal
        isOpen={templatesOpen}
        onClose={() => {
          setTemplatesOpen(false);
          void loadTemplates();
        }}
        projectPath={mode === 'existing' || mode === 'update' ? projectPath : undefined}
      />
    </div>
  );

  return createPortal(modal, document.body);
};
