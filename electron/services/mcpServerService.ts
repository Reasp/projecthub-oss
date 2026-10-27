import http, { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { editionRegistry } from '../extensions/editionRegistry.js';
import { z } from 'zod';
import { projectRegistry } from './projectRegistry.js';
import { processManager } from './processManager.js';
import {
  claudeBridgeService,
  CLI_HITL_PERMISSION_TOOL,
  CLI_HITL_QUERY_PARAM,
  type CliPermissionDecision,
  type CliPermissionEndpoint
} from './claudeBridgeService.js';
import matter from 'gray-matter';
import { hitlService } from './hitlService.js';
import { secretStorageService } from './secretStorageService.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computerUseService, type ComputerCallContext } from './computerUseService.js';
import { jsonSchemaToZodShape } from './jsonSchemaToZod.js';
import { NOTIFY_TOOL_DEFINITION } from './remoteInbox.js';
import { BASE_SYNC_TOOL_DEFINITION, baseSyncAction, runBaseSync } from './baseSync.js';
import { execGit } from './checkpointGit.js';
import { notifyHuman } from './agentNotifier.js';
import { MEMORY_TOOL_DEFINITIONS, callMemoryTool, type MemoryToolContext } from './memoryTools.js';
import { memoryToolDeps } from './memoryToolDeps.js';
import { automationEngine } from './automationService.js';
import { automationToolList, automationToolRun } from './automationTools.js';
import { terminalHookService } from './terminalHookService.js';
import { callProjectTool, projectToolDefinitions, type ProjectToolContext } from './projectAgentTools.js';
import { projectAgentToolDeps } from './projectAgentToolDeps.js';
import { TRACKER_TOOL_DEFINITIONS, callTrackerTool } from './trackerSyncTools.js';
import { trackerToolDeps } from './trackerSyncServiceInstance.js';
import { CI_TOOL_DEFINITIONS, callCiTool } from './ciTools.js';
import { ciToolDeps } from './ciServiceInstance.js';
import { deriveAgentToken, isAgentTokenShape, projectForAgentToken } from './agentToken.js';
import { AppError, type AppErrorKey } from '../../src/lib/appError.js';

/** Маршрут хуков терминальных сессий (TASK-77, decision-54 п. 3–4). */
export const TERMINAL_HOOK_ROUTE = '/api/hooks/event';
/** Лимит тела события хука: вход Write может содержать файл целиком. */
const TERMINAL_HOOK_BODY_LIMIT = 8 * 1024 * 1024;

/** Ключ персистентного токена MCP-сервера в safeStorage (TASK-58): переживает перезапуск приложения. */
const MCP_TOKEN_SECRET_KEY = 'mcp_server_token';
/** Секрет, из которого выводятся токены агентов проектов (TASK-136.6, decision-78 п. 12). */
const MCP_AGENT_SECRET_KEY = 'mcp_agent_secret';

export interface McpServerStatus {
  isRunning: boolean;
  port: number;
  activeSessions: number;
  token: string;
  url: string;
  /** Последняя ошибка запуска (например, не удалось подобрать свободный порт). */
  lastError: string | null;
  /** Код ошибки старта (decision-165): окно показывает её на своём языке. */
  lastErrorKey?: AppErrorKey | null;
}

/** Публичная часть статуса, отдаваемая по HTTP без аутентификации (без токена). */
export type McpServerPublicStatus = Omit<McpServerStatus, 'token'>;

const REMOTE_ACTION_TYPES: ReadonlySet<RemoteActionPayload['type']> = new Set([
  'switch_project',
  'switch_tab',
  'send_studio_prompt',
  'approve_action',
  'open_terminal',
  'refresh_tasks'
]);

/** Сколько последовательных портов пробовать при EADDRINUSE, прежде чем сдаться. */
const MAX_PORT_ATTEMPTS = 10;

export interface RemoteActionPayload {
  type:
    | 'switch_project'
    | 'switch_tab'
    | 'send_studio_prompt'
    | 'approve_action'
    | 'open_terminal'
    | 'refresh_tasks';
  payload: any;
}

interface SseSession {
  /**
   * `sse` — прежний транспорт (`/sse` + `/message`, Claude Code); `http` — Streamable HTTP (`/mcp`, TASK-161): его
   * понимают Antigravity и клиенты, где SSE уже снят по спецификации MCP.
   */
  kind: 'sse' | 'http';
  transport: SSEServerTransport | StreamableHTTPServerTransport;
  /** Свой McpServer на подключение: SDK привязывает ответы к последнему подключённому транспорту. */
  mcpServer: McpServer;
  /** Сессия Agents Studio, для которой Claude CLI запрашивает разрешения (query-параметр SSE-URL). */
  hitlSessionId?: string;
  /** Зарегистрированные инструменты прокси управления компьютером `computer_*` (TASK-82). */
  computerTools: RegisteredTool[];
  /** Сессия по токену агента: корень проекта, к которому привязан токен (TASK-136.6). */
  agentProject?: string;
  /** Последний запрос сессии Streamable HTTP: у неё нет сокета, по закрытию которого видно, что клиент ушёл. */
  lastSeen?: number;
}

/** Сессия Streamable HTTP без запросов дольше этого закрывается: клиент, который упал или вышел без DELETE, её не закроет. */
const HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Не больше стольких сессий Streamable HTTP на один токен (основной или проекта): при превышении закрывается самая старая. */
const HTTP_SESSIONS_PER_OWNER = 16;
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

type McpAuth = { kind: 'main' } | { kind: 'agent'; projectRoot: string };

class McpServerService {
  private server: http.Server | null = null;
  private sseSessions = new Map<string, SseSession>();
  /** Обход брошенных сессий Streamable HTTP; заводится с первой такой сессией, снимается в stop(). */
  private httpSweepTimer: NodeJS.Timeout | null = null;
  private port = 42042;
  private token: string;
  private agentSecret: string;
  private lastError: string | null = null;
  private lastErrorKey: AppErrorKey | null = null;
  private currentAppState = {
    activeProject: null as any,
    activeTab: 'kanban'
  };

  constructor() {
    this.token = `ph_mcp_${crypto.randomBytes(12).toString('hex')}`;
    this.agentSecret = crypto.randomBytes(32).toString('hex');
    // Набор computer_* меняется при включении/выключении функции и после запуска рантайма —
    // подключённые клиенты получают notifications/tools/list_changed от SDK при перерегистрации.
    const resync = () => {
      for (const [sseSessionId, session] of this.sseSessions) this.syncComputerTools(session, sseSessionId);
    };
    computerUseService.on('toolsChanged', resync);
    computerUseService.on('settingsChanged', resync);
  }

  /**
   * Загружает персистентный токен из safeStorage (TASK-58), если он уже был сгенерирован раньше;
   * иначе сохраняет токен, сгенерированный в конструкторе, как первый постоянный. Вызывается один
   * раз при старте приложения, до `start()` — иначе внешний конфиг Claude Code/Cursor протухает
   * при каждом перезапуске ProjectHub.
   */
  public async init(): Promise<void> {
    // Набор инструментов агента проекта — и для серверного режима модулей Team (TASK-195): они не дублируют инструменты.
    editionRegistry.setProjectMcpFactory((projectRoot, sessionId, memberId) => this.createAgentMcpServer(projectRoot, sessionId, memberId));
    try {
      const stored = await secretStorageService.getSecret(MCP_TOKEN_SECRET_KEY);
      if (stored) {
        this.token = stored;
      } else {
        await secretStorageService.setSecret(MCP_TOKEN_SECRET_KEY, this.token);
      }
    } catch (err) {
      console.warn('[MCPServer] Failed to load the persistent token, using a temporary one:', err);
    }
    // Секрет токенов агентов: постоянный, чтобы токен в окружении открытого терминала не протухал.
    try {
      const storedAgent = await secretStorageService.getSecret(MCP_AGENT_SECRET_KEY);
      if (storedAgent) this.agentSecret = storedAgent;
      else await secretStorageService.setSecret(MCP_AGENT_SECRET_KEY, this.agentSecret);
    } catch (err) {
      console.warn('[MCPServer] Failed to load the agent token secret, using a temporary one:', err);
    }
    // Токен хуков терминала (TASK-77) — отдельный секрет с правом только на маршрут хуков.
    await terminalHookService.getToken().catch((err) => {
      console.warn('[MCPServer] Failed to load the terminal hook token:', err);
    });
  }

  /** Адрес сервера для скрипта хуков (`PROJECTHUB_HOOK_URL`); null — сервер не запущен. */
  public getHookBaseUrl(): string | null {
    return this.server && this.server.listening ? `http://127.0.0.1:${this.port}` : null;
  }

  /**
   * Окружение агента проекта во встроенном терминале (TASK-136.6): адрес SSE и токен агента этого
   * проекта. Основной токен сюда не попадает. Пусто, если сервер не запущен.
   */
  public agentEnv(projectPath: string): Record<string, string> {
    if (!this.server || !this.server.listening) return {};
    return {
      PROJECTHUB_MCP_URL: `http://127.0.0.1:${this.port}/sse`,
      PROJECTHUB_AGENT_TOKEN: deriveAgentToken(this.agentSecret, projectPath)
    };
  }

  public setAppState(state: { activeProject?: any; activeTab?: string }) {
    if (state.activeProject !== undefined) this.currentAppState.activeProject = state.activeProject;
    if (state.activeTab !== undefined) this.currentAppState.activeTab = state.activeTab;
  }

  public getStatus(): McpServerStatus {
    return {
      isRunning: Boolean(this.server && this.server.listening),
      port: this.port,
      activeSessions: this.sseSessions.size,
      token: this.token,
      url: `http://127.0.0.1:${this.port}/sse`,
      lastError: this.lastError,
      lastErrorKey: this.lastErrorKey
    };
  }

  /** Статус без секретов — для неаутентифицированного GET /api/status. */
  public getPublicStatus(): McpServerPublicStatus {
    const { token: _token, ...publicStatus } = this.getStatus();
    return publicStatus;
  }

  public regenerateToken(): string {
    this.token = `ph_mcp_${crypto.randomBytes(12).toString('hex')}`;
    secretStorageService.setSecret(MCP_TOKEN_SECRET_KEY, this.token).catch((err) => {
      console.warn('[MCPServer] Failed to save the new token:', err);
    });
    this.broadcastStatus();
    return this.token;
  }

  /**
   * Push-статус в рендерер (`mcp:statusChanged`) при старте/остановке сервера, смене токена
   * и подключении/отключении SSE-сессий — вместо опроса `mcp:getStatus` по таймеру (аудит 3.9).
   */
  private broadcastStatus() {
    const status = this.getStatus();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('mcp:statusChanged', status);
      }
    }
  }

  /**
   * Адрес для --permission-prompt-tool Claude CLI (TASK-42): поднимает сервер, если он не
   * запущен. null — запустить не удалось (см. lastError).
   */
  public async ensurePermissionEndpoint(): Promise<CliPermissionEndpoint | null> {
    if (!(this.server && this.server.listening)) {
      const ok = await this.start(this.port);
      if (!ok) return null;
    }
    return { url: `http://127.0.0.1:${this.port}/sse`, token: this.token };
  }

  private dispatchToRenderer(action: RemoteActionPayload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('mcp:remoteAction', action);
      }
    }
  }

  public async start(customPort = 42042): Promise<boolean> {
    if (this.server && this.server.listening) return true;

    this.port = customPort;
    this.lastError = null;
    this.lastErrorKey = null;

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      let attempts = 0;
      let settled = false;

      const fail = (err: AppError) => {
        if (settled) return;
        settled = true;
        const message = err.message;
        this.lastError = message;
        this.lastErrorKey = err.appErrorKey;
        console.error(`[MCPServer] ${message}`);
        try {
          server.close();
        } catch {}
        this.broadcastStatus();
        resolve(false);
      };

      server.on('listening', () => {
        if (settled) return;
        settled = true;
        console.log(`[MCPServer] ProjectHub Remote MCP Server running at http://127.0.0.1:${this.port}/sse`);
        this.server = server;
        this.broadcastStatus();
        resolve(true);
      });

      server.on('error', (err: any) => {
        if (settled) {
          // Ошибка уже работающего сервера — не трогаем результат start(), только логируем.
          console.error('[MCPServer] HTTP server error:', err);
          return;
        }
        if (err?.code === 'EADDRINUSE') {
          attempts++;
          if (attempts >= MAX_PORT_ATTEMPTS) {
            fail(new AppError('mcp.noFreePort', { from: customPort, to: this.port, n: MAX_PORT_ATTEMPTS }));
            return;
          }
          console.warn(`[MCPServer] Port ${this.port} is in use, trying ${this.port + 1}...`);
          this.port++;
          server.listen(this.port, '127.0.0.1');
          return;
        }
        fail(new AppError('mcp.httpStartFailed', { detail: err?.message || String(err) }));
      });

      server.listen(this.port, '127.0.0.1');
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    if (this.httpSweepTimer) clearInterval(this.httpSweepTimer);
    this.httpSweepTimer = null;

    for (const session of this.sseSessions.values()) {
      try {
        await session.mcpServer.close();
      } catch {}
      try {
        await session.transport.close();
      } catch {}
    }
    this.sseSessions.clear();

    const srv = this.server;
    this.server = null;

    if (typeof srv.closeAllConnections === 'function') {
      try {
        srv.closeAllConnections();
      } catch {}
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, 500);

      srv.close(() => {
        clearTimeout(timer);
        console.log('[MCPServer] Remote MCP Server stopped');
        resolve();
      });
    }).then(() => this.broadcastStatus());
  }

  /**
   * Создаёт McpServer для одного SSE-подключения. `hitlSessionId` задан, если подключился
   * Claude CLI сессии Agents Studio (URL /sse?phSession=...): тогда инструмент разрешений
   * отвечает от имени именно этой сессии.
   */
  private createMcpServer(hitlSessionId?: string): McpServer {
    const server = new McpServer({
      name: 'projecthub-remote-control',
      version: '2.5.0'
    });

    // ─────────────────────────────────────────────────────────────
    // 0. Permission prompt tool для Claude CLI (--permission-prompt-tool, TASK-42)
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      CLI_HITL_PERMISSION_TOOL,
      {
        title: 'Claude Code permission request (Human-in-the-Loop)',
        description:
          'Internal tool for the Claude CLI --permission-prompt-tool flag: shows an approval card '
          + 'in ProjectHub Agents Studio and returns the user\'s decision. Not meant to be called by the model.',
        inputSchema: {
          tool_name: z.string().describe('Claude Code tool name (Bash, Edit, Write, AskUserQuestion, ...)'),
          input: z.record(z.any()).optional().describe('Tool input'),
          tool_use_id: z.string().optional()
        }
      },
      async ({ tool_name, input, tool_use_id }) => {
        let decision: CliPermissionDecision;
        if (!hitlSessionId) {
          decision = {
            behavior: 'deny',
            message: `ProjectHub: the connection is not bound to an Agents Studio session (no ${CLI_HITL_QUERY_PARAM} parameter in the SSE URL).`
          };
        } else {
          try {
            decision = await claudeBridgeService.handleCliPermissionRequest(hitlSessionId, {
              tool_name,
              input: input ?? {},
              tool_use_id
            });
          } catch (err: any) {
            console.error('[MCPServer] permission_prompt failed:', err);
            decision = { behavior: 'deny', message: `ProjectHub: failed to process the permission request: ${err?.message || String(err)}` };
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 1. Get Application & GUI State
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_get_app_state',
      {
        title: 'Current ProjectHub GUI state',
        description: 'Returns the current application state: the open project, the visible tab and the status.',
        inputSchema: {}
      },
      async () => {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeProject: this.currentAppState.activeProject,
                  activeTab: this.currentAppState.activeTab,
                  mcpServer: this.getStatus()
                },
                null,
                2
              )
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 2. List Projects
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_list_projects',
      {
        title: 'List ProjectHub projects',
        description: 'Returns the registry of all added projects with their metadata and paths on disk.',
        inputSchema: {}
      },
      async () => {
        const config = await projectRegistry.getConfig();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(config.projects, null, 2)
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 3. Switch Project in GUI
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_switch_project',
      {
        title: 'Switch project in the ProjectHub window',
        description: 'Selects a project and opens it in the application GUI.',
        inputSchema: {
          projectPath: z.string().describe('Absolute path to the project directory, or the project name')
        }
      },
      async ({ projectPath }) => {
        this.dispatchToRenderer({
          type: 'switch_project',
          payload: { query: projectPath }
        });
        return {
          content: [
            {
              type: 'text',
              text: `The command to switch the project to "${projectPath}" was sent to the ProjectHub GUI.`
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 4. Switch Tab in GUI
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_switch_tab',
      {
        title: 'Switch tab in ProjectHub',
        description: 'Switches the visible tab in the application (ai, kanban, git, docs, terminal).',
        inputSchema: {
          tab: z.enum(['ai', 'kanban', 'git', 'docs', 'terminal', 'analytics']).describe('Tab name')
        }
      },
      async ({ tab }) => {
        this.dispatchToRenderer({
          type: 'switch_tab',
          payload: { tab }
        });
        return {
          content: [
            {
              type: 'text',
              text: `The application tab was switched to "${tab}".`
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 5. Send Prompt to Agents Studio
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_send_studio_prompt',
      {
        title: 'Send a prompt to Agents Studio',
        description: 'Inserts or sends a task to the AI agent in Agents Studio of the open project.',
        inputSchema: {
          prompt: z.string().describe('Task or prompt text for the agent'),
          sendImmediately: z.boolean().optional().describe('Send right away (true) or only insert into the input field (false)')
        }
      },
      async ({ prompt, sendImmediately = true }) => {
        this.dispatchToRenderer({
          type: 'send_studio_prompt',
          payload: { prompt, sendImmediately }
        });
        return {
          content: [
            {
              type: 'text',
              text: `The prompt was passed to Agents Studio (${sendImmediately ? 'sent' : 'inserted'}).`
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 6. Approve / Reject Human-in-the-Loop Action
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_list_pending_approvals',
      {
        title: 'Agent requests awaiting a decision (Human-in-the-Loop)',
        description:
          'Returns the queue of requests waiting for a human decision: requestId, session, agent, tool, '
          + 'command or path. To answer, use projecthub_approve_action with the requestId.',
        inputSchema: {
          projectPath: z.string().optional().describe('Limit to this project')
        }
      },
      async ({ projectPath }) => {
        const list = hitlService.listPending(projectPath ? { projectPath } : {}).map((r) => ({
          requestId: r.id,
          sessionId: r.sessionId,
          projectPath: r.projectPath,
          origin: r.origin,
          agent: r.agentName || r.agentId,
          role: r.role,
          tool: r.tool,
          type: r.type,
          title: r.title,
          command: r.command,
          filePath: r.filePath,
          createdAt: new Date(r.createdAt).toISOString(),
          expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : undefined,
          orphaned: r.orphaned || undefined
        }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
      }
    );

    server.registerTool(
      'projecthub_approve_action',
      {
        title: 'Approve or reject an agent action',
        description:
          'Answers a confirmation request (Human-in-the-Loop) strictly by requestId (see projecthub_list_pending_approvals). '
          + 'The first answer for a requestId wins; a repeated one gets "already decided".',
        inputSchema: {
          requestId: z.string().min(1).describe('Request ID from the queue of pending decisions'),
          approved: z.boolean().describe('Approve (true) or reject (false)'),
          reason: z.string().optional().describe('Optional text explanation or the chosen option')
        }
      },
      async ({ requestId, approved, reason }) => {
        const result = hitlService.decide(requestId, { approved, text: reason }, { kind: 'mcp', deviceName: 'MCP client' });
        if (result.ok) {
          this.dispatchToRenderer({
            type: 'approve_action',
            payload: { requestId, approved, reason, applied: true }
          });
        }
        const text = result.ok
          ? `Decision "${approved ? 'Approved' : 'Rejected'}" applied to request ${requestId}.`
          : result.reason === 'already_decided'
            ? `Request ${requestId} was already decided: the repeated decision was not applied.`
            : `Request ${requestId} was not found in the queue of pending decisions.`;
        return {
          isError: !result.ok,
          content: [
            {
              type: 'text',
              text
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 7. Run Background Process
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_run_process',
      {
        title: 'Run a background process',
        description: 'Runs a command (dev server, tests, build) tracked in the Process Manager.',
        inputSchema: {
          projectPath: z.string().describe('Absolute path to the project directory'),
          command: z.string().describe('Command line to run'),
          name: z.string().describe('Unique process name (e.g. "dev", "test")')
        }
      },
      async ({ projectPath, command, name }) => {
        const proc = await processManager.startProcess(projectPath, command, name);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(proc, null, 2)
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 8. Stop Background Process
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_stop_process',
      {
        title: 'Stop a background process',
        description: 'Stops a process by its ID or name.',
        inputSchema: {
          processId: z.string().describe('Process ID in the form path::name')
        }
      },
      async ({ processId }) => {
        const stopped = await processManager.stopProcess(processId);
        return {
          content: [
            {
              type: 'text',
              text: stopped ? `Process ${processId} stopped.` : `Process ${processId} not found.`
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 9. Get Process Logs
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_get_process_logs',
      {
        title: 'Get process logs',
        description: 'Returns the buffer of the latest output lines of a process.',
        inputSchema: {
          processId: z.string().describe('Process ID in the form path::name'),
          lines: z.number().optional().describe('Number of latest lines (default 50)')
        }
      },
      async ({ processId, lines = 50 }) => {
        const allLogs = processManager.getLogs(processId);
        const tail = allLogs.slice(-lines);
        return {
          content: [
            {
              type: 'text',
              text: tail.join('') || 'No output'
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 10. List Backlog Tasks
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'projecthub_list_tasks',
      {
        title: 'List backlog tasks',
        description: 'Returns the list of tasks from the project\'s backlog/tasks/ folder.',
        inputSchema: {
          projectPath: z.string().describe('Project path'),
          status: z.string().optional().describe('Filter by status (To Do, In Progress, Review, Done)')
        }
      },
      async ({ projectPath, status }) => {
        const tasksDir = path.join(projectPath, 'backlog', 'tasks');
        const list: any[] = [];
        if (existsSync(tasksDir)) {
          const files = await fs.readdir(tasksDir);
          for (const f of files) {
            if (f.endsWith('.md')) {
              try {
                const raw = await fs.readFile(path.join(tasksDir, f), 'utf-8');
                const parsed = matter(raw);
                if (!status || parsed.data.status?.toLowerCase() === status.toLowerCase()) {
                  list.push({
                    file: f,
                    id: parsed.data.id || f.split(' - ')[0],
                    title: parsed.data.title,
                    status: parsed.data.status,
                    priority: parsed.data.priority,
                    labels: parsed.data.labels
                  });
                }
              } catch {}
            }
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(list, null, 2)
            }
          ]
        };
      }
    );

    // ─────────────────────────────────────────────────────────────
    // 11. Память проекта (TASK-76, decision-51 п. 4)
    // ─────────────────────────────────────────────────────────────
    for (const def of MEMORY_TOOL_DEFINITIONS) {
      const properties = (def.input_schema.properties ?? {}) as Record<string, unknown>;
      const schema = {
        ...def.input_schema,
        properties: {
          ...properties,
          projectPath: {
            type: 'string',
            description: 'Project path, for external MCP clients only; a ProjectHub agent knows its project from the session'
          }
        }
      };
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(schema) },
        async (args: Record<string, unknown>) => {
          const ctx = this.memoryCallContext(hitlSessionId, args);
          if (!ctx) {
            return { isError: true, content: [{ type: 'text' as const, text: 'ProjectHub: the agent session has ended or no project is selected, so memory is unavailable.' }] };
          }
          const res = await callMemoryTool(def.name, args, ctx, memoryToolDeps);
          return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
        }
      );
    }

    // ─────────────────────────────────────────────────────────────
    // 11b. Позвать человека на телефоне (TASK-140.5, decision-117 п. 8)
    // ─────────────────────────────────────────────────────────────
    this.registerNotifyTool(server, (args) => this.memoryCallContext(hitlSessionId, args));

    // ─────────────────────────────────────────────────────────────
    // 11c. Подтянуть основную ветку в свой worktree (decision-141) — только агенту ProjectHub: рабочее дерево и
    // git-автор — из его сессии. Одобрение — обычной карточкой permission-prompt Claude CLI.
    // ─────────────────────────────────────────────────────────────
    if (hitlSessionId) {
      server.registerTool(
        BASE_SYNC_TOOL_DEFINITION.name,
        { title: BASE_SYNC_TOOL_DEFINITION.name, description: BASE_SYNC_TOOL_DEFINITION.description, inputSchema: jsonSchemaToZodShape(BASE_SYNC_TOOL_DEFINITION.input_schema) },
        async (args: Record<string, unknown>) => {
          const ctx = claudeBridgeService.getBaseSyncContext(hitlSessionId);
          if (!ctx) return { isError: true, content: [{ type: 'text' as const, text: 'ProjectHub: the agent session has ended.' }] };
          const res = await runBaseSync(execGit, { workDir: ctx.workDir, action: baseSyncAction(args.action), env: ctx.gitEnv });
          return { isError: res.status === 'refused', content: [{ type: 'text' as const, text: res.text }] };
        }
      );
    }

    // ─────────────────────────────────────────────────────────────
    // 11a. Задачи, документы и поиск по документации (TASK-136.6, decision-78 п. 12)
    // ─────────────────────────────────────────────────────────────
    this.registerProjectTools(server, true, (args) => {
      if (hitlSessionId) return claudeBridgeService.getProjectToolContext(hitlSessionId);
      const memoryCtx = this.memoryCallContext(hitlSessionId, args);
      return memoryCtx ? { ...memoryCtx } : null;
    });

    // ─────────────────────────────────────────────────────────────
    // 12. Automations (TASK-74, decision-52 п. 8)
    // ─────────────────────────────────────────────────────────────
    server.registerTool(
      'automation_list',
      {
        title: 'List ProjectHub automations',
        description:
          'Automations rules (global, project, and the built-in assigned-tasks rule): trigger, action, '
          + 'whether it is enabled and confirmed on this machine, daily counters and pause; plus the latest runs from the log.',
        inputSchema: {
          projectPath: z.string().optional().describe('Show only global rules and the rules of this project'),
          recentRuns: z.number().optional().describe('How many latest log entries to return (default 20, up to 100)')
        }
      },
      async ({ projectPath, recentRuns }) => {
        const res = await automationToolList(automationEngine, { projectPath, recentRuns });
        return { content: [{ type: 'text' as const, text: res }] };
      }
    );

    server.registerTool(
      'automation_run',
      {
        title: 'Run an automation now',
        description:
          'Manually runs an Automations rule by its key from automation_list (like the "Run now" button): the same '
          + 'project rule confirmation, daily limits and log, without cooldown. Not available to ProjectHub agents.',
        inputSchema: {
          ruleKey: z.string().describe('Rule key from automation_list, e.g. global:nightly-docs')
        }
      },
      async ({ ruleKey }) => {
        const res = await automationToolRun(automationEngine, { ruleKey, fromAgentSession: Boolean(hitlSessionId) });
        return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
      }
    );

    return server;
  }

  /**
   * Инструменты задач и документов. `withProjectPath` — параметр `projectPath` для внешних клиентов с
   * основным токеном; у сессии агента проекта его нет: проект задан токеном.
   */
  private registerProjectTools(
    server: McpServer,
    withProjectPath: boolean,
    contextFor: (args: Record<string, unknown>) => ProjectToolContext | null
  ): void {
    for (const def of projectToolDefinitions()) {
      const properties = (def.input_schema.properties ?? {}) as Record<string, unknown>;
      const schema = withProjectPath
        ? {
            ...def.input_schema,
            properties: {
              ...properties,
              projectPath: { type: 'string', description: 'Project path, for external MCP clients only; a project agent already knows it' }
            }
          }
        : def.input_schema;
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(schema) },
        async (args: Record<string, unknown>) => {
          const ctx = contextFor(args);
          if (!ctx) {
            return { isError: true, content: [{ type: 'text' as const, text: 'ProjectHub: the agent session has ended or no project is selected.' }] };
          }
          const res = await callProjectTool(def.name, args, ctx, projectAgentToolDeps);
          return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
        }
      );
    }
    // Синк задач с внешним трекером (TASK-128, decision-103 п. 8): тот же контекст проекта, запуск — через HITL.
    for (const def of TRACKER_TOOL_DEFINITIONS) {
      const schema = withProjectPath
        ? {
            ...def.input_schema,
            properties: {
              ...((def.input_schema.properties ?? {}) as Record<string, unknown>),
              projectPath: { type: 'string', description: 'Project path, for external MCP clients only; a project agent already knows it' }
            }
          }
        : def.input_schema;
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(schema) },
        async (args: Record<string, unknown>) => {
          const ctx = contextFor(args);
          if (!ctx) {
            return { isError: true, content: [{ type: 'text' as const, text: 'ProjectHub: the agent session has ended or no project is selected.' }] };
          }
          const res = await callTrackerTool(def.name, args, ctx, trackerToolDeps);
          return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
        }
      );
    }
    // CI/CD (TASK-138.3, decision-109): статус и лог упавшего задания свободно, перезапуск — через HITL.
    for (const def of CI_TOOL_DEFINITIONS) {
      const schema = withProjectPath
        ? {
            ...def.input_schema,
            properties: {
              ...((def.input_schema.properties ?? {}) as Record<string, unknown>),
              projectPath: { type: 'string', description: 'Project path, for external MCP clients only; a project agent already knows it' }
            }
          }
        : def.input_schema;
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(schema) },
        async (args: Record<string, unknown>) => {
          const ctx = contextFor(args);
          if (!ctx) {
            return { isError: true, content: [{ type: 'text' as const, text: 'ProjectHub: the agent session has ended or no project is selected.' }] };
          }
          const res = await callCiTool(def.name, args, ctx, ciToolDeps);
          return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
        }
      );
    }
  }

  /**
   * Сервер для сессии по токену агента проекта (TASK-136.6): только задачи, документы, поиск и память
   * этого проекта. Ни удалённого управления, ни одобрения HITL, ни процессов: токен лежит в окружении
   * агента, и агент не должен одобрять собственные запросы.
   */
  private createAgentMcpServer(projectRoot: string, sseSessionId: string, memberId?: string): McpServer {
    const server = new McpServer({ name: 'projecthub', version: '2.5.0' });
    // `memberId` — агент участника по сети (TASK-195): HITL уходит ему, аудит пишет его, а не владельца хоста.
    const ctx = { sessionPath: projectRoot, sessionId: `agent-${sseSessionId}`, origin: 'terminal' as const, ...(memberId ? { memberId } : {}) };
    this.registerProjectTools(server, false, () => ctx);
    this.registerNotifyTool(server, () => ctx);
    for (const def of MEMORY_TOOL_DEFINITIONS) {
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(def.input_schema) },
        async (args: Record<string, unknown>) => {
          const res = await callMemoryTool(def.name, args, ctx, memoryToolDeps);
          return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
        }
      );
    }
    return server;
  }

  /** `projecthub_notify`: лимит частоты по сессии, текст — только в ленту и шифрованный push (decision-117 п. 8). */
  private registerNotifyTool(server: McpServer, contextFor: (args: Record<string, unknown>) => MemoryToolContext | null): void {
    server.registerTool(
      NOTIFY_TOOL_DEFINITION.name,
      { title: NOTIFY_TOOL_DEFINITION.name, description: NOTIFY_TOOL_DEFINITION.description, inputSchema: jsonSchemaToZodShape(NOTIFY_TOOL_DEFINITION.input_schema) },
      async (args: Record<string, unknown>) => {
        const ctx = contextFor(args);
        const res = await notifyHuman(
          {
            sessionId: ctx?.sessionId ?? 'external-mcp',
            ...(ctx?.sessionPath ? { projectPath: ctx.sessionPath } : {}),
            ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
            ...(ctx?.role ? { role: ctx.role } : {})
          },
          args
        );
        return { isError: res.isError, content: [{ type: 'text' as const, text: res.text }] };
      }
    );
  }

  /**
   * Контекст инструментов памяти: агент ProjectHub (`phSession`) — из его CLI-сессии; внешний MCP-клиент —
   * явный `projectPath` или активный проект окна. Корень проекта по реестру находит `memoryTools`.
   */
  private memoryCallContext(hitlSessionId: string | undefined, args: Record<string, unknown>): MemoryToolContext | null {
    if (hitlSessionId) return claudeBridgeService.getMemoryCallContext(hitlSessionId);
    const explicit = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
    const sessionPath = explicit || String(this.currentAppState.activeProject?.path ?? '');
    if (!sessionPath) return null;
    return { sessionPath, sessionId: 'external-mcp', origin: 'external' };
  }

  /**
   * Прокси управления компьютером (TASK-82, decision-27 п. 2): `computer_*` ре-экспортируются в каждом
   * подключении, когда функция включена и рантайм отдал список инструментов. Политику, HITL, аудит и
   * kill-switch применяет `computerUseService` — одинаково для Claude CLI, внешних клиентов и API-агента.
   */
  private syncComputerTools(session: SseSession, sseSessionId: string): void {
    for (const tool of session.computerTools) {
      try {
        tool.remove();
      } catch {
        /* уже удалён */
      }
    }
    session.computerTools = [];
    for (const def of computerUseService.listProxyTools()) {
      try {
        const registered = session.mcpServer.registerTool(
          def.name,
          { title: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(def.inputSchema) },
          async (args: Record<string, unknown>) => {
            const ctx = this.computerCallContext(session.hitlSessionId, sseSessionId);
            if (!ctx) {
              return { isError: true, content: [{ type: 'text' as const, text: 'ProjectHub: the agent session has ended, so the action was rejected.' }] };
            }
            const res = await computerUseService.callTool(def.name, args, ctx);
            return {
              isError: res.isError,
              content: res.content.map((c) =>
                c.type === 'image' ? { type: 'image' as const, data: c.data, mimeType: c.mimeType } : { type: 'text' as const, text: c.text }
              )
            };
          }
        );
        session.computerTools.push(registered);
      } catch (err) {
        console.warn(`[MCPServer] Failed to register ${def.name}:`, err);
      }
    }
  }

  /** Сессия с `phSession` — агент ProjectHub (контекст из claudeBridgeService); без него — внешний MCP-клиент. */
  private computerCallContext(hitlSessionId: string | undefined, sseSessionId: string): ComputerCallContext | null {
    if (hitlSessionId) return claudeBridgeService.getComputerCallContext(hitlSessionId);
    return {
      sessionId: `external-${sseSessionId}`,
      projectPath: String(this.currentAppState.activeProject?.path ?? ''),
      origin: 'external'
    };
  }

  /**
   * Host должен указывать на loopback — защита от DNS rebinding
   * (страница на evil.com с A-записью 127.0.0.1 присылает Host: evil.com).
   */
  private isLoopbackHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return false;
    }
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  }

  private bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header || Array.isArray(header)) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
  }

  /**
   * Событие хука терминальной сессии (TASK-77): токен хуков или основной токен. Ожидание решения человека
   * отменяется, если скрипт хука оборвал соединение (движок завершил хук).
   */
  private handleTerminalHook(req: IncomingMessage, res: ServerResponse) {
    const presented = this.bearerToken(req);
    if (!presented || !(this.isAuthorized(req) || terminalHookService.isHookToken(presented))) {
      this.sendJson(res, 401, { error: 'Unauthorized: hook token required' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > TERMINAL_HOOK_BODY_LIMIT) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        this.sendJson(res, 413, { error: 'Hook payload too large' });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      terminalHookService
        .handle(body, { signal: controller.signal })
        .then((out) => {
          if (!res.writableEnded && !res.destroyed) this.sendJson(res, 200, out);
        })
        .catch((err) => {
          console.error('[MCPServer] Terminal hook error:', err);
          if (!res.writableEnded && !res.destroyed) this.sendJson(res, 500, { error: 'Hook handling failed' });
        });
    });
  }

  /** Сравнение Bearer-токена за константное время. */
  private isAuthorized(req: IncomingMessage): boolean {
    const token = this.bearerToken(req);
    if (!token) return false;
    const presented = Buffer.from(token, 'utf8');
    const expected = Buffer.from(this.token, 'utf8');
    if (presented.length !== expected.length) return false;
    return crypto.timingSafeEqual(presented, expected);
  }

  private sendJson(res: ServerResponse, statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(JSON.stringify(body, null, 2));
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    // CORS-заголовки не выставляются вовсе: сервер предназначен только для локальных
    // CLI/десктоп-клиентов (Claude Code, Cursor и т.п.), а не для браузерных страниц.
    // Любой запрос с заголовком Origin — это браузер (в т.ч. preflight OPTIONS), отклоняем.
    if (req.headers.origin !== undefined) {
      this.sendJson(res, 403, { error: 'Browser origins are not allowed' });
      return;
    }

    if (!this.isLoopbackHost(req.headers.host)) {
      this.sendJson(res, 403, { error: 'Invalid Host header' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;

    // 1. Status Endpoint: GET /api/status — единственный маршрут без аутентификации, без токена в ответе.
    if (pathname === '/api/status' && req.method === 'GET') {
      this.sendJson(res, 200, this.getPublicStatus());
      return;
    }

    // Хуки терминала (TASK-77): свой токен, который не открывает остальные маршруты.
    if (pathname === TERMINAL_HOOK_ROUTE && req.method === 'POST') {
      this.handleTerminalHook(req, res);
      return;
    }

    // Все остальные маршруты требуют Authorization: Bearer <token> — основной или агента проекта.
    void this.authenticate(req).then((auth) => {
      if (!auth) {
        this.sendJson(res, 401, { error: 'Unauthorized: valid Bearer token required' }, {
          'WWW-Authenticate': 'Bearer realm="ProjectHub MCP"'
        });
        return;
      }
      this.handleAuthorized(req, res, parsedUrl, auth);
    });
  }

  /** Основной токен или токен агента зарегистрированного проекта; иначе null. */
  private async authenticate(req: IncomingMessage): Promise<McpAuth | null> {
    if (this.isAuthorized(req)) return { kind: 'main' };
    const token = this.bearerToken(req);
    if (!token || !isAgentTokenShape(token)) return null;
    const roots = (await projectRegistry.getProjects()).map((p) => p.path);
    const projectRoot = projectForAgentToken(this.agentSecret, token, roots);
    return projectRoot ? { kind: 'agent', projectRoot } : null;
  }

  /** Тело запроса как JSON (до 4 МБ); больше — `tooLarge`, не JSON — `value: undefined`. */
  private readJsonBody(req: IncomingMessage): Promise<{ tooLarge: boolean; value?: unknown }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_HTTP_BODY_BYTES) tooLarge = true;
        else chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return resolve({ tooLarge: true });
        try {
          resolve({ tooLarge: false, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ tooLarge: false });
        }
      });
      req.on('error', () => resolve({ tooLarge: false }));
    });
  }

  /** Закрыть сессии Streamable HTTP без запросов дольше `HTTP_SESSION_IDLE_MS` (вызывается таймером и при новой сессии). */
  private sweepHttpSessions(now = Date.now()): void {
    for (const session of [...this.sseSessions.values()]) {
      if (session.kind === 'http' && now - (session.lastSeen ?? now) > HTTP_SESSION_IDLE_MS) void session.transport.close().catch(() => undefined);
    }
  }

  /** Лимит сессий на владельца: перед открытием новой закрываются самые давние сверх `HTTP_SESSIONS_PER_OWNER - 1`. */
  private limitHttpSessions(agentProject: string | undefined): void {
    const own = [...this.sseSessions.values()]
      .filter((s) => s.kind === 'http' && s.agentProject === agentProject)
      .sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
    for (const stale of own.slice(0, Math.max(0, own.length - (HTTP_SESSIONS_PER_OWNER - 1)))) void stale.transport.close().catch(() => undefined);
  }

  /**
   * Streamable HTTP по спецификации MCP (TASK-161): POST `initialize` без `Mcp-Session-Id` открывает сессию, дальше
   * POST/GET/DELETE с заголовком сессии. Сессию ведёт только тот же токен, что её открыл — как у SSE.
   */
  private async handleStreamableHttp(req: IncomingMessage, res: ServerResponse, parsedUrl: URL, auth: McpAuth): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    const fail = (status: number, message: string) => this.sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });

    if (sessionId) {
      const session = this.sseSessions.get(sessionId);
      if (!session || session.kind !== 'http') return fail(404, 'Session not found');
      const sameOwner = auth.kind === 'main' ? !session.agentProject : session.agentProject === auth.projectRoot;
      if (!sameOwner) return fail(403, 'Session belongs to another token');
      session.lastSeen = Date.now();
      // Тело читаем сами с тем же пределом, что у SSE `/message`: SDK его не ограничивает.
      let body: unknown;
      if (req.method === 'POST') {
        const read = await this.readJsonBody(req);
        if (read.tooLarge) return fail(413, 'Request body is too large');
        body = read.value;
      }
      await (session.transport as StreamableHTTPServerTransport).handleRequest(req, res, body).catch((err) => {
        console.error('[MCPServer] Streamable HTTP request failed:', err);
        if (!res.headersSent) fail(500, 'Internal error');
      });
      return;
    }

    if (req.method !== 'POST') return fail(400, 'Mcp-Session-Id header is required');
    const read = await this.readJsonBody(req);
    if (read.tooLarge) return fail(413, 'Request body is too large');
    const body = read.value;
    if (!isInitializeRequest(body)) return fail(400, 'The first request of a session must be initialize');

    const agentProject = auth.kind === 'agent' ? auth.projectRoot : undefined;
    this.sweepHttpSessions();
    this.limitHttpSessions(agentProject);
    if (!this.httpSweepTimer) {
      this.httpSweepTimer = setInterval(() => this.sweepHttpSessions(), 5 * 60 * 1000);
      this.httpSweepTimer.unref?.();
    }
    const hitlSessionId = agentProject ? undefined : parsedUrl.searchParams.get(CLI_HITL_QUERY_PARAM) || undefined;
    const newId = crypto.randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      onsessioninitialized: () => {
        this.sseSessions.set(newId, session);
        this.broadcastStatus();
      }
    });
    const mcpServer = agentProject ? this.createAgentMcpServer(agentProject, newId) : this.createMcpServer(hitlSessionId);
    const session: SseSession = { kind: 'http', transport, mcpServer, hitlSessionId, computerTools: [], agentProject, lastSeen: Date.now() };
    if (!agentProject) this.syncComputerTools(session, newId);
    transport.onclose = () => {
      if (!this.sseSessions.delete(newId)) return;
      console.log(`[MCPServer] Streamable HTTP session ${newId} closed`);
      computerUseService.forgetSession(`external-${newId}`);
      this.broadcastStatus();
    };
    console.log(`[MCPServer] New Streamable HTTP session${hitlSessionId ? ` (HITL for session ${hitlSessionId})` : ''}${agentProject ? ' (project agent)' : ''}`);
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[MCPServer] Error opening Streamable HTTP session:', err);
      if (!res.headersSent) fail(500, 'Internal error');
    }
  }

  private handleAuthorized(req: IncomingMessage, res: ServerResponse, parsedUrl: URL, auth: McpAuth) {
    const pathname = parsedUrl.pathname;

    // Токен агента открывает только MCP-сессию своего проекта.
    if (auth.kind === 'agent' && pathname !== '/sse' && pathname !== '/message' && pathname !== '/mcp') {
      this.sendJson(res, 403, { error: 'Agent token allows only the MCP session of its project' });
      return;
    }

    // Streamable HTTP (TASK-161, decision-173): тот же набор инструментов, что у SSE, по одному адресу `/mcp`.
    if (pathname === '/mcp') {
      void this.handleStreamableHttp(req, res, parsedUrl, auth);
      return;
    }

    // 2. Direct Action REST Endpoint: POST /api/action
    if (pathname === '/api/action' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json || typeof json !== 'object' || !REMOTE_ACTION_TYPES.has(json.type)) {
            this.sendJson(res, 400, { error: `Unknown action type; allowed: ${[...REMOTE_ACTION_TYPES].join(', ')}` });
            return;
          }
          this.dispatchToRenderer({ type: json.type, payload: json.payload ?? {} });
          this.sendJson(res, 200, { ok: true });
        } catch (e: any) {
          this.sendJson(res, 400, { error: e.message });
        }
      });
      return;
    }

    // 3. /mcp.json намеренно удалён: конфиг-сниппет с токеном копируется только из UI (McpServerStatusBadge).

    // 4. SSE Stream: GET /sse
    if (pathname === '/sse' && req.method === 'GET') {
      const agentProject = auth.kind === 'agent' ? auth.projectRoot : undefined;
      // `phSession` — только для основного токена: агент проекта не может выдать себя за сессию Agents Studio.
      const hitlSessionId = agentProject ? undefined : parsedUrl.searchParams.get(CLI_HITL_QUERY_PARAM) || undefined;
      console.log(
        `[MCPServer] New client connected to SSE stream${hitlSessionId ? ` (HITL for session ${hitlSessionId})` : ''}${agentProject ? ' (project agent)' : ''}`
      );
      const transport = new SSEServerTransport('/message', res);
      const sessionId = transport.sessionId;
      const mcpServer = agentProject ? this.createAgentMcpServer(agentProject, sessionId) : this.createMcpServer(hitlSessionId);
      const session: SseSession = { kind: 'sse', transport, mcpServer, hitlSessionId, computerTools: [], agentProject };
      this.sseSessions.set(sessionId, session);
      // Инструменты управления компьютером (TASK-82) — до connect, чтобы попасть в первый tools/list.
      if (!agentProject) this.syncComputerTools(session, sessionId);
      this.broadcastStatus();

      transport.onclose = () => {
        console.log(`[MCPServer] SSE Session ${sessionId} closed`);
        this.sseSessions.delete(sessionId);
        computerUseService.forgetSession(`external-${sessionId}`);
        this.broadcastStatus();
      };

      // connect() сам вызывает transport.start(); повторный явный start() давал
      // ошибку "SSEServerTransport already started" в логе на каждое подключение.
      mcpServer.connect(transport).catch((err) => {
        console.error('[MCPServer] Error connecting transport to MCP server:', err);
      });
      return;
    }

    // 5. SSE POST Message: POST /message?sessionId=...
    if (pathname === '/message' && req.method === 'POST') {
      const sessionId = parsedUrl.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400).end('Missing sessionId query param');
        return;
      }

      const session = this.sseSessions.get(sessionId);
      if (!session || session.kind !== 'sse') {
        res.writeHead(404).end(`Session ${sessionId} not found`);
        return;
      }
      // Сессию основного токена ведёт только основной токен, сессию агента — токен того же проекта.
      const sameOwner = auth.kind === 'main' ? !session.agentProject : session.agentProject === auth.projectRoot;
      if (!sameOwner) {
        this.sendJson(res, 403, { error: 'Session belongs to another token' });
        return;
      }

      (session.transport as SSEServerTransport).handlePostMessage(req as any, res).catch((err) => {
        console.error('[MCPServer] Error handling POST message:', err);
        if (!res.headersSent) {
          res.writeHead(500).end(err.message);
        }
      });
      return;
    }

    // 404 Fallback
    res.writeHead(404).end('Not found');
  }
}

export const mcpServerService = new McpServerService();
