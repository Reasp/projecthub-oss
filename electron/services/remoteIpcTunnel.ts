import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { AppError } from '../../src/lib/appError.js';

/**
 * Туннель IPC для проекта другого ПК (TASK-280, [[decision-194]]): хост исполняет свои же обработчики `ipcMain.handle`
 * по запросу удалённого окна и отдаёт ему события своего окна. Здесь только механика — реестр обработчиков и отвод
 * событий; что пропускать и кому, решают `remoteIpcPolicy` и `remoteControlService`.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type IpcRegistrar = Pick<IpcMain, 'handle'>;

const handlers = new Map<string, Listener>();
const registries = new WeakSet<object>();

/**
 * Запоминать обработчики при регистрации. Вызывается после `installAppErrorEnvelope`: в реестр попадает исходный
 * обработчик, и ошибка с кодом уходит удалённому окну как есть, без конверта окна.
 */
export function installIpcRegistry(ipc: IpcRegistrar): void {
  if (registries.has(ipc)) return;
  registries.add(ipc);
  const handle = ipc.handle.bind(ipc);
  ipc.handle = (channel, listener) => {
    handlers.set(channel, listener as Listener);
    return handle(channel, listener);
  };
}

let windowContents: WebContents | null = null;
type EventListener = (channel: string, args: unknown[]) => void;
const eventListeners = new Set<EventListener>();
const tapped = new WeakSet<object>();

/**
 * Отвод событий главного окна: всё, что main отправляет окну, видят и подписчики туннеля. Окно хоста получает события
 * как раньше — запуск агента удалённым окном виден и на самом хосте.
 */
export function tapWindowEvents(contents: WebContents): void {
  windowContents = contents;
  if (tapped.has(contents)) return;
  tapped.add(contents);
  const send = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => {
    send(channel, ...args);
    if (eventListeners.size === 0) return;
    for (const listener of eventListeners) {
      try {
        listener(channel, args);
      } catch (err) {
        console.warn('[RemoteIpcTunnel] Event listener failed:', err);
      }
    }
  };
}

export function onWindowEvent(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/**
 * Вызвать зарегистрированный обработчик. Отправитель события — главное окно хоста: обработчики, отвечающие через
 * `event.sender`, пишут в окно хоста, а отвод событий переправляет это удалённому окну.
 */
export async function invokeRegisteredHandler(channel: string, args: unknown[]): Promise<unknown> {
  const listener = handlers.get(channel);
  if (!listener) throw new AppError('remote.ipcChannelNotAllowed', { channel });
  const event = { sender: windowContents, senderFrame: null, processId: 0, frameId: 0 } as unknown as IpcMainInvokeEvent;
  return await listener(event, ...args);
}
