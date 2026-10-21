import { useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { useServices } from '../app/context';
import { useT } from '../i18n/react';

/**
 * Страница клиента, открытая по ссылке сопряжения в браузере компьютера (TASK-186, [[decision-143]] п. 4): там обычно
 * нужен не веб-клиент, а ProjectHub. Кнопка отдаёт ту же ссылку приложению — оно откроет заполненную форму хоста.
 */
export function DesktopAppBanner() {
  const { platform } = useServices();
  const tr = useT();
  const [link] = useState(() => platform.desktopAppLink?.() ?? null);
  const [hidden, setHidden] = useState(false);
  if (!link || hidden) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[10000] flex items-center gap-3 border-b border-indigo-500/40 bg-indigo-950/95 px-4 py-2 text-[13px]" data-testid="desktop-app-banner">
      <span className="min-w-0 flex-1 text-slate-200">{tr.fleet.openInAppHint}</span>
      <a href={link} className="shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 font-medium text-white hover:bg-indigo-400">
        {tr.fleet.openInApp}
      </a>
      <button type="button" aria-label={tr.fleet.dismiss} onClick={() => setHidden(true)} className="shrink-0 rounded-full p-1 text-slate-400 hover:text-slate-200">
        <XIcon size={18} />
      </button>
    </div>
  );
}
