import type { BacklogRenumberSummary } from '../types/electron';

export interface RenumberMessageStrings {
  renumberMessage: string;
  renumberMentions: string;
}

const fill = (template: string, params: Record<string, string | number>) =>
  Object.entries(params).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);

/**
 * Текст подтверждения перенумерации входящей стороны перед слиянием (decision-76 п. 6): какие записи получат
 * новые номера и сколько упоминаний будет заменено. Длинный план обрезается: полный список — в сообщении слияния.
 */
export function buildRenumberMessage(
  summary: Pick<BacklogRenumberSummary, 'renumber' | 'mentionCount' | 'fileCount'>,
  branch: string,
  target: string,
  t: RenumberMessageStrings,
  limit = 25
): string {
  const lines = summary.renumber.slice(0, limit).map((r) => `${r.from} → ${r.to}`);
  if (summary.renumber.length > limit) lines.push(`… +${summary.renumber.length - limit}`);
  return [
    fill(t.renumberMessage, { branch, target }),
    '',
    ...lines,
    '',
    fill(t.renumberMentions, { count: summary.mentionCount, files: summary.fileCount })
  ].join('\n');
}
