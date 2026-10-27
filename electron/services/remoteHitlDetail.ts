import type { RemoteHitlDetail } from '../../src/types/remote.js';
import type { HitlRequest } from './hitlTypes.js';

/**
 * Полный запрос HITL для телефона перед одобрением (TASK-140.6, [[decision-114]] п. 3). События `ai:hitl` и
 * `get_pending_approvals` идут без диффа: его содержимое — код проекта. Дифф отдаётся только по `requestId`, только
 * устройству с правом решений и только пока запрос ждёт решения — человек подтверждает биометрией то, что видит.
 */

/** Сколько текста отдать телефону: дифф до 200 тыс. символов, пояснение — до 50 тыс. */
export const PHONE_DIFF_LIMIT = 200_000;
export const PHONE_DETAILS_LIMIT = 50_000;

function cut(value: string, limit: number): { text: string; truncated: boolean } {
  return value.length <= limit ? { text: value, truncated: false } : { text: value.slice(0, limit), truncated: true };
}

/**
 * Помещается ли запрос на экран телефона целиком. Усечённый дифф биометрией не одобряется: человек подтвердил бы
 * то, чего не видел. Хост проверяет это сам, клиент лишь не предлагает кнопку.
 */
export function fitsPhoneReview(request: HitlRequest): boolean {
  const detail = hitlDetailForPhone(request);
  return !detail.diff?.truncated && !detail.detailsTruncated;
}

export function hitlDetailForPhone(request: HitlRequest): RemoteHitlDetail {
  const out: RemoteHitlDetail = {
    requestId: request.id,
    title: request.title,
    ...(request.textKey ? { textKey: request.textKey } : {}),
    ...(request.tool || request.type ? { tool: request.tool || request.type } : {}),
    ...(request.risk ? { risk: request.risk } : {}),
    ...(request.riskReason ? { riskReason: request.riskReason } : {}),
    ...(request.riskReasonKey ? { riskReasonKey: request.riskReasonKey } : {}),
    // Команду не режем: одобряется ровно то, что будет выполнено.
    ...(request.command ? { command: request.command } : {}),
    ...(request.filePath || request.diff?.filePath ? { filePath: request.filePath || request.diff?.filePath } : {})
  };
  if (request.details) {
    const d = cut(request.details, PHONE_DETAILS_LIMIT);
    out.details = d.text;
    if (d.truncated) out.detailsTruncated = true;
  }
  if (request.diff) {
    // Новый файл приходит без патча — показываем содержимое целиком как добавленные строки.
    const patch =
      request.diff.patch ||
      (request.diff.newContent
        ? request.diff.newContent
            .split('\n')
            .map((line) => `+${line}`)
            .join('\n')
        : '');
    const p = cut(patch, PHONE_DIFF_LIMIT);
    out.diff = { filePath: request.diff.filePath, patch: p.text, truncated: p.truncated };
  }
  return out;
}
