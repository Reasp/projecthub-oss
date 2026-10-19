import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus,
  Target,
  LayoutGrid,
  List,
  Search,
  CheckSquare,
  AlertCircle,
  Bot,
  X
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import type { BacklogTask } from '../../types/electron';
import { isAwaitingApproval, pendingByReporter, withoutApprovalLabel } from '../../utils/agentTask';
import {
  matchStatus,
  isKnownStatus,
  fallbackColumnStatus,
  resolveDoneStatus,
  statusLabel,
  statusVisual
} from '../../utils/taskStatus';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskListView } from './TaskListView';

export const KanbanBoard: React.FC = () => {
  const { t } = useTranslation();
  const dialog = useDialog();
  const {
    tasks,
    milestones,
    selectedProject,
    taskViewMode,
    setTaskViewMode,
    selectedLabelFilter,
    setSelectedLabelFilter,
    selectedMilestoneFilter,
    setSelectedMilestoneFilter,
    taskRefToOpen,
    requestOpenTask,
    updateTaskStatusLocal,
    saveFullTaskLocal,
    deleteTaskLocal,
    toggleCriterionLocal,
    loadProjectData,
    backlogConfig
  } = useProjectStore();

  // Колонки доски — из `statuses` в `backlog/config.yml` проекта (TASK-68, decision-24).
  // Стандартные четыре статуса сохраняют прежние цвета и переведённые подписи,
  // кастомные выводятся как есть и получают цвет из палитры по хэшу имени.
  const statuses = backlogConfig.statuses;
  const columns = useMemo(
    () =>
      statuses.map((status) => ({
        status,
        label: statusLabel(status, t.kanban),
        ...statusVisual(status)
      })),
    [statuses, t]
  );

  /** Колонка для задач, чей статус не описан в конфиге: `default_status` проекта. */
  const fallbackColumn = fallbackColumnStatus(backlogConfig);
  const doneStatus = resolveDoneStatus(statuses);
  const reviewStatus = matchStatus(statuses, 'Review');

  const [selectedTask, setSelectedTask] = useState<BacklogTask | null>(null);
  // Переход по ссылке `[[TASK-N]]` из документа или другой задачи (TASK-121): открыть карточку.
  useEffect(() => {
    if (!taskRefToOpen) return;
    const target = tasks.find((task) => task.id.toLowerCase() === taskRefToOpen.toLowerCase());
    if (target) setSelectedTask(target);
    requestOpenTask(null);
  }, [taskRefToOpen, tasks, requestOpenTask]);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newLabels, setNewLabels] = useState('');
  const [searchTaskQuery, setSearchTaskQuery] = useState('');
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  // Фильтр «Ждут подтверждения» и подтверждение пачкой по автору-агенту (decision-89).
  const [awaitingOnly, setAwaitingOnly] = useState(false);
  const [approvingReporter, setApprovingReporter] = useState<string | null>(null);
  const awaitingCount = useMemo(() => tasks.filter((task) => isAwaitingApproval(task.labels)).length, [tasks]);
  const pendingGroups = useMemo(() => pendingByReporter(tasks), [tasks]);
  // Всё подтверждено — фильтр гаснет сам, а не оставляет пустую доску.
  const awaitingFilterOn = awaitingOnly && awaitingCount > 0;

  const handleApproveAllByReporter = async (reporter: string, count: number) => {
    if (!selectedProject || approvingReporter) return;
    const proceed = await dialog.confirm({
      message: t.kanban.approveAllByReporterConfirm.replace('{count}', String(count)).replace('{reporter}', reporter),
      confirmText: t.kanban.approveAllByReporter.replace('{reporter}', reporter).replace('{count}', String(count))
    });
    if (!proceed) return;
    setApprovingReporter(reporter);
    try {
      const { approved } = await window.api.approveAgentTasksByReporter(selectedProject.path, reporter);
      await loadProjectData(selectedProject, { silent: true });
      await dialog.alert({ message: t.kanban.approvedAllByReporter.replace('{count}', String(approved.length)) });
    } finally {
      setApprovingReporter(null);
    }
  };

  // Extract all unique labels
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.labels) {
        for (const l of t.labels) set.add(l);
      }
    }
    return Array.from(set);
  }, [tasks]);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((taskItem) => {
      const matchQuery =
        taskItem.title.toLowerCase().includes(searchTaskQuery.toLowerCase()) ||
        taskItem.id.toLowerCase().includes(searchTaskQuery.toLowerCase()) ||
        (taskItem.description && taskItem.description.toLowerCase().includes(searchTaskQuery.toLowerCase()));
      if (!matchQuery) return false;
      if (awaitingFilterOn && !isAwaitingApproval(taskItem.labels)) return false;
      if (selectedLabelFilter &&(!taskItem.labels || !taskItem.labels.includes(selectedLabelFilter))) {
        return false;
      }
      if (selectedMilestoneFilter) {
        const mKey = selectedMilestoneFilter.toLowerCase();
        const tMilestone = taskItem.milestone?.toLowerCase();
        const matchedM = milestones.find((m) => m.id.toLowerCase() === mKey);
        const matches =
          tMilestone === mKey ||
          (matchedM && tMilestone === matchedM.title.toLowerCase());
        if (!matches) return false;
      }
      return true;
    });
  }, [tasks, searchTaskQuery, awaitingFilterOn, selectedLabelFilter, selectedMilestoneFilter, milestones]);

  // Раскладка по колонкам: сопоставление статуса нестрогое (регистр/пробелы не значимы),
  // а задача с неизвестным статусом попадает в колонку по умолчанию с пометкой,
  // а не исчезает с доски, как было до TASK-68.
  const tasksByColumn = useMemo(() => {
    const map = new Map<string, BacklogTask[]>();
    for (const col of columns) map.set(col.status, []);
    for (const taskItem of filteredTasks) {
      const matched = matchStatus(statuses, taskItem.status || fallbackColumn);
      const target = matched || fallbackColumn;
      const bucket = map.get(target);
      if (bucket) bucket.push(taskItem);
      else map.set(target, [taskItem]);
    }
    return map;
  }, [columns, filteredTasks, statuses, fallbackColumn]);

  // Progress metrics
  const doneCount = doneStatus
    ? tasks.filter((taskItem) => matchStatus([doneStatus], taskItem.status) !== undefined).length
    : 0;
  const progressPercent = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;

  // Drag & Drop handlers
  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingTaskId(taskId);
  };

  const handleDragOver = (e: React.DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverColumn !== status) {
      setDragOverColumn(status);
    }
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    setDragOverColumn(null);
    setDraggingTaskId(null);

    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;

    const targetTask = tasks.find((taskItem) => taskItem.id === taskId);
    if (!targetTask || targetTask.status === targetStatus) return;

    // Rule 5 check: moving to Done directly.
    // Предупреждение работает и на кастомном наборе: показывается при переносе в конечный
    // статус, если в конфиге вообще есть Review и задача сейчас не в Review/Done.
    const currentIsReviewOrDone =
      (!!reviewStatus && matchStatus([reviewStatus], targetTask.status) !== undefined) ||
      (!!doneStatus && matchStatus([doneStatus], targetTask.status) !== undefined);
    if (reviewStatus && targetStatus === doneStatus && !currentIsReviewOrDone) {
      const proceed = await dialog.confirm({
        title: t.kanban.rule5Title,
        message: t.kanban.rule5Message.replace('{id}', targetTask.id),
        confirmText: t.kanban.moveToDoneAnyway,
        cancelText: t.kanban.moveToReviewInstead,
        danger: true
      });
      if (!proceed) {
        // Move to Review instead
        updateTaskStatusLocal(taskId, reviewStatus);
        return;
      }
    }

    updateTaskStatusLocal(taskId, targetStatus);
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !selectedProject || !window.api) return;

    const labels = newLabels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);

    const created = await window.api.createTask(selectedProject.path, {
      title: newTitle.trim(),
      description: newDesc.trim(),
      labels
    });

    if (created) {
      setIsCreateOpen(false);
      setNewTitle('');
      setNewDesc('');
      setNewLabels('');
      loadProjectData(selectedProject);
    }
  };

  const segment = (active: boolean) =>
    `flex items-center gap-1.5 h-6 px-2 rounded text-xs transition whitespace-nowrap ${
      active ? 'bg-ph-hover text-slate-100' : 'text-slate-400 hover:text-slate-200'
    }`;
  const filterSelect =
    'h-7 bg-ph-raised border border-transparent rounded-md px-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 w-36 min-w-[96px] shrink';

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden select-none">
      {/*
        Панель вида (decision-73): одна строка вместо «дашбордного» заголовка с прогресс-баром.
        Метки — выпадающим списком: 20+ чипов в ряд не читались и уезжали за край.
      */}
      <div className="h-11 px-4 flex items-center gap-2.5 border-b border-ph-line shrink-0 min-w-0">
        <h3 className="text-[13px] font-medium text-slate-100 shrink-0">{t.tabs.tasks}</h3>
        <span
          className="flex items-center gap-2 text-xs text-slate-500 tabular-nums shrink-0"
          title={`${t.analytics.taskCompletionRate}: ${doneCount} / ${tasks.length}`}
        >
          <span className="w-16 h-1 rounded-full bg-ph-raised overflow-hidden">
            <span className="block h-full bg-emerald-500/80" style={{ width: `${progressPercent}%` }} />
          </span>
          {doneCount}/{tasks.length}
        </span>

        <div className="w-px h-4 bg-ph-line shrink-0" />

        <div className="relative w-48 shrink min-w-[120px]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchTaskQuery}
            onChange={(e) => setSearchTaskQuery(e.target.value)}
            placeholder={t.kanban.searchTasks}
            className="w-full h-7 bg-ph-raised border border-transparent rounded-md pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition"
          />
        </div>

        {allLabels.length > 0 && (
          <select
            value={selectedLabelFilter || ''}
            onChange={(e) => setSelectedLabelFilter(e.target.value || null)}
            className={`${filterSelect} ${selectedLabelFilter ? 'text-indigo-300' : ''}`}
            title={selectedLabelFilter ? t.kanban.filterByTag.replace('{tag}', selectedLabelFilter) : t.kanban.allLabels}
          >
            <option value="">{t.kanban.allLabels}</option>
            {allLabels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        )}

        {milestones.length > 0 && (
          <select
            value={selectedMilestoneFilter || ''}
            onChange={(e) => setSelectedMilestoneFilter(e.target.value || null)}
            className={`${filterSelect} ${selectedMilestoneFilter ? 'text-indigo-300' : ''}`}
            title={t.kanban.filterByMilestone}
          >
            <option value="">{t.kanban.allStages}</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}: {m.title}
              </option>
            ))}
          </select>
        )}

        {/* Задачи агентов, которые ждут человека (decision-89): кнопка видна, только пока такие есть */}
        {awaitingCount > 0 && (
          <button
            type="button"
            onClick={() => setAwaitingOnly(!awaitingFilterOn)}
            aria-pressed={awaitingFilterOn}
            data-testid="awaiting-approval-filter"
            title={t.kanban.awaitingApprovalFilterHint}
            className={`flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition whitespace-nowrap shrink-0 ${
              awaitingFilterOn ?'bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/40' : 'bg-ph-raised text-sky-300 hover:text-sky-200'
            }`}
          >
            <Bot className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden xl:inline">{t.kanban.awaitingApprovalFilter}</span>
            <span className="tabular-nums">{awaitingCount}</span>
          </button>
        )}

        {(selectedLabelFilter || selectedMilestoneFilter || awaitingFilterOn) && (
          <button
            type="button"
            onClick={() => {
              setSelectedLabelFilter(null);
              setSelectedMilestoneFilter(null);
              setAwaitingOnly(false);
            }}
            className="ph-icon-button shrink-0"
            title={t.kanban.resetMilestoneFilter}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <div className="flex items-center p-0.5 rounded-md bg-ph-raised">
            <button onClick={() => setTaskViewMode('kanban')} title={t.kanban.viewKanban} className={segment(taskViewMode === 'kanban')}>
              <LayoutGrid className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden 2xl:inline">{t.kanban.viewKanban}</span>
            </button>
            <button onClick={() => setTaskViewMode('list')} title={t.kanban.viewList} className={segment(taskViewMode === 'list')}>
              <List className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden 2xl:inline">{t.kanban.viewList}</span>
            </button>
          </div>

          <button
            onClick={() => setIsCreateOpen(true)}
            title={t.kanban.newTask}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs text-white transition whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden xl:inline">{t.kanban.newTask}</span>
          </button>
        </div>
      </div>

      {/* Подтверждение пачкой: по одной кнопке на автора-агента */}
      {awaitingFilterOn && pendingGroups.length > 0 && (
        <div
          data-testid="awaiting-approval-bar"
          className="px-4 py-1.5 flex items-center gap-2 flex-wrap border-b border-ph-line bg-sky-950/20 shrink-0"
        >
          {pendingGroups.map((group) => (
            <button
              key={group.reporter}
              type="button"
              disabled={approvingReporter !== null}
              onClick={() => void handleApproveAllByReporter(group.reporter, group.tasks.length)}
              data-testid="approve-all-by-reporter"
              className="ph-btn ph-btn-primary h-6 text-xs"
            >
              {approvingReporter === group.reporter
                ? t.common.loading
                : t.kanban.approveAllByReporter.replace('{reporter}', group.reporter).replace('{count}', String(group.tasks.length))}
            </button>
          ))}
        </div>
      )}

      {/* Main Content Area: Kanban Board or List View */}
      {taskViewMode === 'list' ? (
        <div className="flex-1 flex flex-col overflow-hidden p-4">
          <TaskListView
            tasks={filteredTasks}
            statuses={statuses}
            onSelectTask={setSelectedTask}
            onUpdateStatus={updateTaskStatusLocal}
          />
        </div>
      ) : (
        <div
          className="flex-1 grid gap-3 p-4 overflow-x-auto overflow-y-hidden"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(240px, 1fr))` }}
        >
          {columns.map((col) => {
            const colTasks = tasksByColumn.get(col.status) || [];
            const isTarget = dragOverColumn === col.status;

            return (
              <div
                key={col.status}
                onDragOver={(e) => handleDragOver(e, col.status)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.status)}
                className={`flex flex-col h-full min-h-0 rounded-lg transition-colors ${
                  isTarget ? 'bg-indigo-500/10 ring-1 ring-indigo-500/50' : 'bg-ph-base/50'
                }`}
              >
                {/* Заголовок колонки: цвет только у точки статуса */}
                <div className="h-9 px-3 flex items-center gap-2 shrink-0">
                  <span className={`w-2 h-2 rounded-full ${col.dot}`} />
                  <span className="text-xs font-medium text-slate-200 truncate" title={col.status}>
                    {col.label}
                  </span>
                  <span className="text-xs text-slate-500 tabular-nums">{colTasks.length}</span>
                </div>

                {/* Column Task Cards with DnD */}
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5" title={colTasks.length === 0 ? t.kanban.moveTaskHint : undefined}>
                  {colTasks.length === 0 && (
                    <div className="py-6 text-center text-xs text-slate-600">{t.kanban.noTasks}</div>
                  )}

                  {colTasks.map((task) => {
                    const criteria = task.acceptanceCriteria || [];
                    const completedCriteria = criteria.filter((c) => c.completed).length;
                    const isDraggingThis = draggingTaskId === task.id;
                    const awaitingApproval = isAwaitingApproval(task.labels);
                    const labels = withoutApprovalLabel(task.labels || []);

                    return (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, task.id)}
                        onClick={() => setSelectedTask(task)}
                        title={labels.length > 0 ? labels.join(', ') : undefined}
                        className={`px-3 py-2.5 rounded-md bg-ph-elevated border border-ph-line hover:border-slate-600 cursor-grab active:cursor-grabbing transition-colors flex flex-col gap-1.5 ${
                          isDraggingThis ? 'opacity-40' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span className="font-mono">{task.id}</span>
                          {task.created && <span className="tabular-nums">{task.created.slice(0, 10)}</span>}
                        </div>

                        <h4 className="text-[13px] text-slate-100 line-clamp-2 leading-snug">{task.title}</h4>

                        {/* Задачу завёл агент, человек её ещё не подтвердил (decision-89) */}
                        {awaitingApproval && (
                          <div
                            title={t.kanban.agentCreatedHint}
                            data-testid="agent-created-badge"
                            className="flex items-center gap-1 text-[11px] text-sky-300 w-fit"
                          >
                            <Bot className="w-3 h-3 shrink-0" />
                            <span>{t.kanban.agentCreatedBadge}</span>
                          </div>
                        )}

                        {/* Статус вне statuses конфига: задача показана в колонке по умолчанию,
                            но её собственный статус не теряется и виден на карточке (TASK-68). */}
                        {!isKnownStatus(statuses, task.status) && (
                          <div
                            title={t.kanban.unknownStatusHint}
                            className="flex items-center gap-1 text-[11px] text-amber-300 w-fit"
                          >
                            <AlertCircle className="w-3 h-3 shrink-0" />
                            <span>{task.status || '—'}</span>
                          </div>
                        )}

                        {/* Одна строка метаданных: критерии, этап, метки */}
                        {(criteria.length > 0 || task.milestone || labels.length > 0) && (
                          <div className="flex items-center gap-2.5 text-[11px] text-slate-500 min-w-0">
                            {criteria.length > 0 && (
                              <span
                                className={`flex items-center gap-1 tabular-nums shrink-0 ${
                                  completedCriteria === criteria.length ? 'text-emerald-400/80' : ''
                                }`}
                                title={`${completedCriteria}/${criteria.length} ${t.kanban.criteriaCount}`}
                              >
                                <CheckSquare className="w-3 h-3" />
                                {completedCriteria}/{criteria.length}
                              </span>
                            )}
                            {task.milestone && (
                              <span className="flex items-center gap-1 shrink-0">
                                <Target className="w-3 h-3" />
                                {task.milestone}
                              </span>
                            )}
                            {labels.length > 0 && (
                              <span className="truncate min-w-0">
                                {labels.slice(0, 2).join(' · ')}
                                {labels.length > 2 && ` +${labels.length - 2}`}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Task Details Modal */}
      {selectedTask && (
        <TaskDetailModal
          key={selectedTask.id}
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onSave={saveFullTaskLocal}
          onDelete={deleteTaskLocal}
          onToggleCriterion={toggleCriterionLocal}
        />
      )}

      {/* Create Task Modal */}
      {isCreateOpen &&
        createPortal(
          <div
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsCreateOpen(false);
            }}
            className="fixed inset-0 bg-black/60 z-[9999] flex items-center justify-center p-6 animate-in fade-in duration-150 select-text"
          >
            <form
              onSubmit={handleCreateTask}
              className="w-full max-w-lg bg-ph-elevated border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden select-text"
            >
              <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-ph-hover/70">
                <h3 className="text-sm font-semibold text-white">{t.createTask.title}</h3>
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4 text-xs select-text">
                <div>
                  <label className="text-slate-300 font-medium block mb-1">
                    {t.createTask.taskTitle} *
                  </label>
                  <input
                    type="text"
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder={t.createTask.taskTitlePlaceholder}
                    className="w-full bg-ph-elevated border border-slate-800 rounded-lg px-3 py-2 text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition select-text cursor-text selection:bg-indigo-600/40"
                  />
                </div>

                <div>
                  <label className="text-slate-300 font-medium block mb-1">
                    {t.createTask.description}
                  </label>
                  <textarea
                    rows={4}
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder={t.createTask.descriptionPlaceholder}
                    className="w-full bg-ph-elevated border border-slate-800 rounded-lg px-3 py-2 text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition select-text cursor-text selection:bg-indigo-600/40"
                  />
                </div>

                <div>
                  <label className="text-slate-300 font-medium block mb-1">
                    {t.createTask.labels}
                  </label>
                  <input
                    type="text"
                    value={newLabels}
                    onChange={(e) => setNewLabels(e.target.value)}
                    placeholder={t.createTask.labelsPlaceholder}
                    className="w-full bg-ph-elevated border border-slate-800 rounded-lg px-3 py-2 text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition select-text cursor-text selection:bg-indigo-600/40"
                  />
                </div>
              </div>

              <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-ph-elevated">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  {t.common.cancel}
                </button>
                <button
                  type="submit"
                  className="ph-btn ph-btn-primary"
                >
                  {t.createTask.createButton}
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </div>
  );
};

