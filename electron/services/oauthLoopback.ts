import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CALLBACK_PATH, checkCallback } from './oauthFlow.js';

/**
 * Приём кода авторизации на loopback (RFC 8252 §7.3, decision-102 п. 3). Сервер слушает только
 * `127.0.0.1` и закрывается после первого правильного ответа, отмены или тайм-аута. Запросы с чужим
 * `state` и на другие пути отклоняются, но вход не обрывают: так посторонний запрос на порт не сорвёт его.
 */

export const LOOPBACK_HOST = '127.0.0.1';

export type LoopbackFailure = 'timeout' | 'cancelled' | 'denied' | 'noCode';

export class LoopbackError extends Error {
  constructor(
    public readonly reason: LoopbackFailure,
    public readonly detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'LoopbackError';
  }
}

export interface LoopbackHandle {
  port: number;
  redirectUri: string;
  /** Код авторизации; отклоняется с `LoopbackError`. */
  code: Promise<string>;
  close(): void;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  '<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;' +
  'justify-content:center;height:100vh;margin:0}main{max-width:28rem;text-align:center}</style></head>' +
  `<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const SUCCESS_PAGE = PAGE('ProjectHub', 'Вход выполнен, вкладку можно закрыть. / Signed in, you can close this tab.');
const DENIED_PAGE = PAGE('ProjectHub', 'Вход отменён. / Sign-in was cancelled.');
const BAD_PAGE = PAGE('ProjectHub', 'Неверный запрос. / Invalid request.');

export function startLoopbackServer(options: { state: string; port?: number; timeoutMs: number }): Promise<LoopbackHandle> {
  return new Promise((resolveHandle, rejectHandle) => {
    let settle: { resolve: (code: string) => void; reject: (err: LoopbackError) => void } | null = null;
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Отказ до того, как кто-то ждёт `code`, не должен становиться unhandled rejection.
    code.catch(() => undefined);
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const server = http.createServer((req, res) => {
      const send = (status: number, body: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(body);
      };
      if (done || req.method !== 'GET') return send(done ? 410 : 405, BAD_PAGE);
      const check = checkCallback(req.url ?? '/', options.state);
      if (!check.ok) {
        if (check.error === 'path' || check.error === 'state') return send(check.error === 'path' ? 404 : 400, BAD_PAGE);
        send(200, DENIED_PAGE);
        finish(new LoopbackError(check.error === 'denied' ? 'denied' : 'noCode', check.detail));
        return;
      }
      send(200, SUCCESS_PAGE);
      finish(null, check.code);
    });

    const finish = (err: LoopbackError | null, value?: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (err) settle?.reject(err);
      else settle?.resolve(value!);
    };

    server.on('error', (err) => {
      if (!done) rejectHandle(err);
    });
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      const port = (server.address() as AddressInfo).port;
      timer = setTimeout(() => finish(new LoopbackError('timeout')), options.timeoutMs);
      timer.unref?.();
      resolveHandle({
        port,
        redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
        code,
        close: () => finish(new LoopbackError('cancelled'))
      });
    });
  });
}
