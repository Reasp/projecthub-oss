import { createClickUpAdapter } from './clickupAdapter.js';
import { createGithubIssuesAdapter } from './githubIssuesAdapter.js';
import { createJiraAdapter } from './jiraAdapter.js';
import { createLinearAdapter } from './linearAdapter.js';
import type { TrackerAdapter } from './trackerAdapter.js';

/** Адаптеры синка трекеров (decision-103, decision-106): порядок — порядок в окне выбора. */
export const TRACKER_ADAPTERS: readonly TrackerAdapter[] = [createClickUpAdapter(), createGithubIssuesAdapter(), createLinearAdapter(), createJiraAdapter()];

export function findTrackerAdapter(id: string, adapters: readonly TrackerAdapter[] = TRACKER_ADAPTERS): TrackerAdapter | undefined {
  return adapters.find((a) => a.id === id);
}
