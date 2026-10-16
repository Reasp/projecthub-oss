/**
 * Токен агента проекта для встроенного MCP ProjectHub (decision-78, п. 12; TASK-136.6).
 *
 * Основной токен MCP открывает всё: удалённое управление, одобрение HITL-запросов, процессы. Агенту
 * в терминале проекта он не выдаётся — иначе агент мог бы одобрить собственный запрос. Вместо него
 * терминал получает `PROJECTHUB_AGENT_TOKEN`: HMAC секрета ProjectHub по пути проекта. Токен
 * открывает только инструменты задач, документов, поиска и памяти — и только этого проекта.
 * Чистый модуль: секрет и список проектов приходят снаружи.
 */
import crypto from 'node:crypto';
import path from 'node:path';

export const AGENT_TOKEN_PREFIX = 'ph_agent_';

/** Ключ проекта: абсолютный путь, на Windows без учёта регистра, без завершающего разделителя. */
export function projectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function deriveAgentToken(secret: string, projectPath: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`projecthub-agent:${projectKey(projectPath)}`).digest('base64url');
  return `${AGENT_TOKEN_PREFIX}${mac}`;
}

export function isAgentTokenShape(token: string): boolean {
  return token.startsWith(AGENT_TOKEN_PREFIX) && token.length > AGENT_TOKEN_PREFIX.length + 20;
}

/** Проект, которому выдан токен; `null` — токен не подходит ни к одному зарегистрированному проекту. */
export function projectForAgentToken(secret: string, token: string, projectRoots: readonly string[]): string | null {
  if (!isAgentTokenShape(token)) return null;
  const presented = Buffer.from(token, 'utf8');
  for (const root of projectRoots) {
    const expected = Buffer.from(deriveAgentToken(secret, root), 'utf8');
    if (presented.length === expected.length && crypto.timingSafeEqual(presented, expected)) return root;
  }
  return null;
}
