import { useState } from 'react';
import { LinkIcon, QrCodeIcon, WarningIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useServices } from '../app/context';
import { Button } from '../components/ui';
import { useT } from '../i18n/react';
import { applyPairingLink, isValidKeyHex, parsePairingText, profileProblems, type HostProfile } from '../protocol/pairing';

const input = 'w-full rounded-xl border border-ph-line bg-ph-raised px-3 py-3 text-[15px] outline-none focus:border-indigo-500';

/**
 * Сопряжение: ссылка из QR (сканер Telegram или вставка), либо поля вручную. В браузере на
 * `http://<IP>` шифрования нет — объясняем, что делать, и не подключаемся открытым текстом.
 */
export function PairingScreen({ initial, error, canCancel = false }: { initial: HostProfile; error?: string | null; canCancel?: boolean }) {
  const { platform, pair, cancelAdd } = useServices();
  const tr = useT();
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
      setLinkError(tr.pairing.notPairingLink);
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
          {canCancel ? tr.pairing.introAdd : tr.pairing.intro}
        </div>
        {canCancel && (
          <button type="button" className="mt-3 text-[14px] text-indigo-400" onClick={() => cancelAdd()}>
            {tr.pairing.backToPaired}
          </button>
        )}
      </div>

      {!crypto && (
        <div className="mt-5 rounded-xl border border-amber-800 bg-amber-950/50 p-3 text-[13px] leading-snug text-amber-100">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <WarningIcon size={18} /> {tr.pairing.noCryptoTitle}
          </div>
          {tr.pairing.noCryptoLead}
          <span className="font-mono">{window.location.origin}</span>
          {tr.pairing.noCryptoTail}
        </div>
      )}

      {(error || linkError) && <div className="mt-4 rounded-xl bg-red-950/60 p-3 text-[13px] text-red-200">{linkError || error}</div>}

      <div className="mt-6 space-y-2">
        {platform.scanQr && (
          <Button variant="primary" size="lg" className="w-full" onClick={scan}>
            <QrCodeIcon size={22} /> {tr.pairing.scanQr}
          </Button>
        )}
        <div className="flex gap-2">
          <input value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder={tr.pairing.pasteLink} className={input} />
          <Button className="h-auto shrink-0" disabled={!linkText.trim()} onClick={() => applyText(linkText)} aria-label={tr.pairing.applyLink}>
            <LinkIcon size={20} />
          </Button>
        </div>
      </div>

      <button type="button" className="mt-5 text-[14px] text-indigo-400" onClick={() => setManual((v) => !v)}>
        {manual ? tr.pairing.hideManual : tr.pairing.showManual}
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
                {m === 'lan' ? tr.pairing.modeLan : tr.pairing.modeRelay}
              </button>
            ))}
          </div>
          {profile.mode === 'lan' && !hostServed && (
            <input value={profile.lanAddress ?? ''} onChange={(e) => patch({ lanAddress: e.target.value.trim() })} placeholder={tr.pairing.lanAddressPlaceholder} className={input} />
          )}
          {profile.mode === 'relay' && (
            <>
              <input value={profile.relayUrl ?? ''} onChange={(e) => patch({ relayUrl: e.target.value.trim() })} placeholder={tr.pairing.relayPlaceholder} className={input} />
              <input value={profile.hostId} onChange={(e) => patch({ hostId: e.target.value.trim() })} placeholder={tr.pairing.hostIdPlaceholder} className={input} />
            </>
          )}
          <input
            value={profile.key}
            onChange={(e) => patch({ key: e.target.value.trim() })}
            placeholder={tr.pairing.keyPlaceholder}
            className={clsx(input, 'font-mono text-[13px]', profile.key && !isValidKeyHex(profile.key) && 'border-red-700')}
            autoComplete="off"
            spellCheck={false}
          />
          {problems.length > 0 && (
            <ul className="space-y-1 text-[12px] text-slate-400">
              {problems.map((p) => (
                <li key={p}>• {tr.pairing.problems[p]}</li>
              ))}
            </ul>
          )}
          <Button variant="primary" size="lg" className="w-full" disabled={problems.length > 0 || !crypto} haptic="medium" onClick={() => pair(profile)}>
            {tr.pairing.connect}
          </Button>
        </div>
      )}

      {platform.store.kind === 'memory' && (
        <div className="mt-6 text-[12px] leading-snug text-slate-500">
          {tr.pairing.memoryStoreNote}
        </div>
      )}
    </div>
  );
}
