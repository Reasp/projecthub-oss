import type { HostDefaults } from './types';

/**
 * Хост, раздающий встроенный клиент и Mini App, вставляет в HTML
 * `<script id="ph-host-defaults" type="application/json">…</script>` (см.
 * `electron/services/remoteStaticClient.ts`). Это данные, а не код: читаем как JSON.
 */
export function readHostDefaults(doc: Document = document): HostDefaults {
  const el = doc.getElementById('ph-host-defaults');
  if (!el?.textContent) return {};
  try {
    const parsed = JSON.parse(el.textContent) as Record<string, unknown>;
    return {
      hostId: typeof parsed.hostId === 'string' ? parsed.hostId : undefined,
      relayUrl: typeof parsed.relayUrl === 'string' ? parsed.relayUrl : undefined,
      mode: parsed.mode === 'relay' || parsed.mode === 'lan' ? parsed.mode : undefined
    };
  } catch {
    return {};
  }
}

/** Ссылка сопряжения в hash содержит ключ — после чтения убираем её из адресной строки и истории. */
export function consumeLocationHash(): string {
  const hash = window.location.hash;
  if (hash && hash.length > 1) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // песочница без history API
    }
  }
  return hash;
}
