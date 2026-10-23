import type { IpcMain } from 'electron';
import { appErrorFields, withAppErrorEnvelope, type AppErrorKey } from '../../src/lib/appError.js';

/**
 * Ошибки main с кодом на пути IPC (TASK-202, [[decision-165]]). Electron передаёт в окно только `message` исключения,
 * поэтому каждый обработчик `ipcMain.handle` оборачивается один раз при регистрации: `AppError` уходит с конвертом
 * `[ph-error]` в последней строке `message`. Сама ошибка и журнал остаются с чистым английским текстом.
 */

type Handler = Parameters<IpcMain['handle']>[1];
type IpcRegistrar = Pick<IpcMain, 'handle' | 'handleOnce'>;

const installed = new WeakSet<object>();

function wrap(listener: Handler): Handler {
  return async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } catch (err) {
      throw withAppErrorEnvelope(err);
    }
  };
}

/** Вызывается до регистрации обработчиков; повторный вызов ничего не меняет. */
export function installAppErrorEnvelope(ipc: IpcRegistrar): void {
  if (installed.has(ipc)) return;
  installed.add(ipc);
  const handle = ipc.handle.bind(ipc);
  const handleOnce = ipc.handleOnce.bind(ipc);
  ipc.handle = (channel, listener) => handle(channel, wrap(listener));
  ipc.handleOnce = (channel, listener) => handleOnce(channel, wrap(listener));
}

export interface IpcFailure {
  ok: false;
  error: string;
  errorKey?: AppErrorKey;
}

/** Результат `{ ok: false }` для каналов, которые не бросают: английский `error` и код рядом. */
export function toIpcFailure(err: unknown): IpcFailure {
  return { ok: false, ...appErrorFields(err) };
}
