import { useState } from 'react';
import { LinkIcon, QrCodeIcon, WarningIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useServices } from '../app/context';
import { Button } from '../components/ui';
import { applyPairingLink, isValidKeyHex, parsePairingText, profileProblems, type HostProfile, type ProfileProblem } from '../protocol/pairing';

const PROBLEM_TEXT: Record<ProfileProblem, string> = {
  no_key: 'Нужен ключ шифрования из QR-кода ProjectHub.',
  bad_key: 'Ключ должен быть из 64 шестнадцатеричных символов.',
  no_relay: 'Для релея нужен адрес сервера.',
  no_host_id: 'Для релея нужен Host ID.',
  no_lan_address: 'Нужен адрес ПК в локальной сети, например 192.168.1.5:42050.'
};

const input = 'w-full rounded-xl border border-ph-line bg-ph-raised px-3 py-3 text-[15px] outline-none focus:border-indigo-500';

/**
 * Сопряжение: ссылка из QR (сканер Telegram или вставка), либо поля вручную. В браузере на
 * `http://<IP>` шифрования нет — объясняем, что делать, и не подключаемся открытым текстом.
 */
export function PairingScreen({ initial, error, canCancel = false }: { initial: HostProfile; error?: string | null; canCancel?: boolean }) {
  const { platform, pair, cancelAdd } = useServices();
  const [profile, setProfile] = useState<HostProfile>(initial);
  const [linkText, setLinkText] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [manual, setManual] = useState(!initial.key);
  const crypto = platform.cryptoAvailable();
  const hostServed = Boolean(platform.pageHostAddress());
  const problems = profileProblems(profile);

  const applyText = (text: string) => {
    const link = parsePairingText(text);
    if (!link.key && !link.hostId && !link.pin && !link.hostKey) {
      setLinkError('Не похоже на ссылку сопряжения ProjectHub.');
      return;
    }
    setLinkError(null);
    const next = applyPairingLink(profile, link);
    // Страница этого же хоста — идём на её адрес; QR другого ПК несёт свои адреса (TASK-140.2).
    const pageHostId = platform.hostDefaults().hostId;
    if (hostServed && (!next.hostId || !pageHostId || next.hostId === pageHostId)) next.lanAddress = platform.pageHostAddress();
    setProfile(next);
    platform.haptic('success');
    if (profileProblems(next).length === 0 && crypto) pair(next);
  };

  const scan = async () => {
    const text = await platform.scanQr?.();
    if (text) applyText(text);
  };

  const patch = (p: Partial<HostProfile>) => setProfile((prev) => ({ ...prev, ...p }));

  return (
    <div className="h-full overflow-y-auto px-4 pb-10 pt-safe">
      <div className="pt-8">
        <div className="text-[24px] font-semibold">ProjectHub</div>
        <div className="mt-1 text-[14px] text-slate-400">
          {canCancel
            ? 'Ещё один компьютер: откройте Remote Control в ProjectHub на нём и отсканируйте QR-код. Уже сопряжённые компьютеры останутся в списке.'
            : 'Пульт агентов на вашем компьютере. Откройте Remote Control в ProjectHub и отсканируйте QR-код.'}
        </div>
        {canCancel && (
          <button type="button" className="mt-3 text-[14px] text-indigo-400" onClick={() => cancelAdd()}>
            ← К сопряжённым компьютерам
          </button>
        )}
      </div>

      {!crypto && (
        <div className="mt-5 rounded-xl border border-amber-800 bg-amber-950/50 p-3 text-[13px] leading-snug text-amber-100">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <WarningIcon size={18} /> Шифрование недоступно на этой странице
          </div>
          Браузер даёт WebCrypto только по HTTPS. Страница открыта по <span className="font-mono">{window.location.origin}</span>, поэтому
          зашифрованное соединение невозможно, а открытым текстом клиент не подключается. Включите в ProjectHub HTTPS-туннель
          Remote Control и откройте ссылку туннеля, Telegram Mini App или мобильное приложение.
        </div>
      )}

      {(error || linkError) && <div className="mt-4 rounded-xl bg-red-950/60 p-3 text-[13px] text-red-200">{linkError || error}</div>}

      <div className="mt-6 space-y-2">
        {platform.scanQr && (
          <Button variant="primary" size="lg" className="w-full" onClick={scan}>
            <QrCodeIcon size={22} /> Сканировать QR-код
          </Button>
        )}
        <div className="flex gap-2">
          <input value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder="Вставьте ссылку сопряжения" className={input} />
          <Button className="h-auto shrink-0" disabled={!linkText.trim()} onClick={() => applyText(linkText)} aria-label="Применить ссылку">
            <LinkIcon size={20} />
          </Button>
        </div>
      </div>

      <button type="button" className="mt-5 text-[14px] text-indigo-400" onClick={() => setManual((v) => !v)}>
        {manual ? 'Скрыть ручной ввод' : 'Ввести вручную'}
      </button>

      {manual && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-ph-raised p-1">
            {(['lan', 'relay'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => patch({ mode: m })}
                className={clsx('rounded-lg py-2 text-[14px]', profile.mode === m ? 'bg-indigo-500 text-white' : 'text-slate-300')}
              >
                {m === 'lan' ? 'Локальная сеть' : 'Через релей'}
              </button>
            ))}
          </div>
          {profile.mode === 'lan' && !hostServed && (
            <input value={profile.lanAddress ?? ''} onChange={(e) => patch({ lanAddress: e.target.value.trim() })} placeholder="Адрес ПК: 192.168.1.5:42050" className={input} />
          )}
          {profile.mode === 'relay' && (
            <>
              <input value={profile.relayUrl ?? ''} onChange={(e) => patch({ relayUrl: e.target.value.trim() })} placeholder="Релей: wss://relay.example.com" className={input} />
              <input value={profile.hostId} onChange={(e) => patch({ hostId: e.target.value.trim() })} placeholder="Host ID: ph_host_…" className={input} />
            </>
          )}
          <input
            value={profile.key}
            onChange={(e) => patch({ key: e.target.value.trim() })}
            placeholder="Ключ шифрования (64 hex)"
            className={clsx(input, 'font-mono text-[13px]', profile.key && !isValidKeyHex(profile.key) && 'border-red-700')}
            autoComplete="off"
            spellCheck={false}
          />
          {problems.length > 0 && (
            <ul className="space-y-1 text-[12px] text-slate-400">
              {problems.map((p) => (
                <li key={p}>• {PROBLEM_TEXT[p]}</li>
              ))}
            </ul>
          )}
          <Button variant="primary" size="lg" className="w-full" disabled={problems.length > 0 || !crypto} haptic="medium" onClick={() => pair(profile)}>
            Подключиться
          </Button>
        </div>
      )}

      {platform.store.kind === 'memory' && (
        <div className="mt-6 text-[12px] leading-snug text-slate-500">
          Ключ устройства хранится только до закрытия приложения: защищённое хранилище (Keychain/Keystore) ещё не подключено.
        </div>
      )}
    </div>
  );
}
