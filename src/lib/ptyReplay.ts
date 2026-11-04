/**
 * Повтор вывода терминала при монтировании xterm (TASK-292, decision-216). Живые чанки несут `end` — сколько символов
 * сессия вывела к концу чанка; снимок буфера — тот же счётчик на момент снимка. Чанки, пришедшие, пока шёл запрос
 * снимка, дописываются только своей частью после снимка.
 */

export interface PtyLiveChunk {
  data: string;
  /** Позиция конца чанка в выводе сессии; нет у хоста старой версии — тогда чанк считается новым. */
  end?: number;
}

/** Часть отложенных чанков, которой нет в снимке, заканчивающемся на `snapshotEnd`. */
export function ptyChunksAfter(pending: readonly PtyLiveChunk[], snapshotEnd: number): string {
  let out = '';
  for (const chunk of pending) {
    if (typeof chunk.end !== 'number') {
      out += chunk.data;
      continue;
    }
    if (chunk.end <= snapshotEnd) continue;
    const start = chunk.end - chunk.data.length;
    out += start >= snapshotEnd ? chunk.data : chunk.data.slice(snapshotEnd - start);
  }
  return out;
}
