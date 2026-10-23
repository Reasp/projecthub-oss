/**
 * Служебные подписи, которые хост сохраняет в записях как английский текст (TASK-202.7, [[decision-165]]): источник
 * решения HITL в журнале, автор ветки документации. Клиент показывает известную подпись на своём языке; старые записи с
 * русской подписью узнаются тоже. Незнакомое значение (имя устройства, агента) — как есть.
 *
 * Чистый модуль без React и Electron: его используют окно и мобильный клиент.
 */
import type { Language } from './types';

type HostLabel = 'mcpClient' | 'systemNotification' | 'terminalAgent' | 'externalMcpClient' | 'apiAgent' | 'agent';

const STORED: Record<string, HostLabel> = {
  'MCP client': 'mcpClient',
  'MCP-клиент': 'mcpClient',
  'System notification': 'systemNotification',
  'Системное уведомление': 'systemNotification',
  'terminal agent': 'terminalAgent',
  'агент в терминале': 'terminalAgent',
  // Кто управляет компьютером, когда у сессии нет имени агента и роли (TASK-202.9).
  'External MCP client': 'externalMcpClient',
  'API agent': 'apiAgent',
  Agent: 'agent'
};

const TEXT: Record<Language, Record<HostLabel, string>> = {
  en: {
    mcpClient: 'MCP client',
    systemNotification: 'System notification',
    terminalAgent: 'terminal agent',
    externalMcpClient: 'External MCP client',
    apiAgent: 'API agent',
    agent: 'Agent'
  },
  ru: {
    mcpClient: 'MCP-клиент',
    systemNotification: 'Системное уведомление',
    terminalAgent: 'агент в терминале',
    externalMcpClient: 'Внешний MCP-клиент',
    apiAgent: 'API-агент',
    agent: 'Агент'
  }
};

export function hostLabelText(value: string, lang: Language): string {
  const label = STORED[value];
  return label ? (TEXT[lang] ?? TEXT.en)[label] : value;
}
