import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  ExternalLink,
  Copy,
  Check,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Unplug
} from '../common/icons';
import { useConnectionsStore } from '../../store/useConnectionsStore';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import type {
  ConnectionAuthMethod,
  ConnectionFlowView,
  ConnectionInput,
  ConnectionServiceInfo,
  ConnectionStatus,
  ConnectionView
} from '../../types/electron';

/**
 * Окно «Подключения» (TASK-138.1, decision-102): подключения к внешним сервисам для интеграций —
 * добавить, проверить, переподключить, переименовать, удалить; какие интеграции их используют.
 * Секреты в рендерер не возвращаются: поле токена только отправляется в main.
 */

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  connected: 'bg-emerald-500/15 text-emerald-300 border-emerald-700/50',
  needsReauth: 'bg-amber-500/15 text-amber-300 border-amber-700/50',
  error: 'bg-rose-500/15 text-rose-300 border-rose-700/50',
  unchecked: 'bg-slate-700/40 text-slate-300 border-slate-600'
};

const inputClass =
  'w-full bg-ph-panel border border-ph-line rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500';

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function openLink(url?: string) {
  if (url) void window.api.openExternal(url);
}

interface FormState {
  reconnect?: ConnectionView;
}

export const ConnectionsModal: React.FC = () => {
  const { t } = useTranslation();
  const tc = t.connections;
  const { isOpen, close, services, connections, loading, refresh, setConnections, setFlow } = useConnectionsStore();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { confirm, prompt, alert } = useDialog();

  useEffect(() => {
    if (!isOpen || !window.api?.connections) return;
    void refresh().catch(() => undefined);
    const offList = window.api.connections.onChanged(setConnections);
    const offFlow = window.api.connections.onFlowChanged(setFlow);
    return () => {
      offList();
      offFlow();
    };
  }, [isOpen, refresh, setConnections, setFlow]);

  useEffect(() => {
    if (!isOpen) {
      setForm(null);
      setNotice(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      await alert({ title: tc.title, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = (c: ConnectionView) =>
    run(c.id, async () => {
      const usage = c.usedBy.length > 0 ? `\n\n${fill(tc.removeUsedWarning, { list: c.usedBy.join(', ') })}` : '';
      const ok = await confirm({
        title: tc.removeConfirmTitle,
        message: `${fill(tc.removeConfirm, { name: c.label })}${usage}`,
        confirmText: tc.remove,
        danger: true
      });
      if (!ok) return;
      const result = await window.api.connections.remove(c.id);
      if (result.remoteRevoke === 'revoked' || result.remoteRevoke === 'notNeeded') setNotice(tc.removed);
      else if (result.manualRevokeUrl) {
        const text = result.remoteRevoke === 'failed' ? tc.revokeFailed : tc.revokeUnsupported;
        setNotice(fill(text, { url: result.manualRevokeUrl }));
      } else setNotice(tc.removed);
      await refresh();
    });

  const handleRename = (c: ConnectionView) =>
    run(c.id, async () => {
      const label = await prompt({ title: tc.rename, message: tc.renamePrompt, defaultValue: c.label });
      if (label === null || !label.trim()) return;
      await window.api.connections.rename(c.id, label);
    });

  const handleCheck = (c: ConnectionView) =>
    run(c.id, async () => {
      await window.api.connections.check(c.id);
    });

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="w-full max-w-2xl bg-ph-elevated border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
        data-testid="connections-modal"
      >
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Unplug className="w-4 h-4 text-indigo-300" />
            {tc.title}
          </h2>
          <button onClick={close} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" title={tc.close}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-3 text-xs">
          {notice && (
            <div className="p-2.5 rounded-lg bg-slate-800/60 border border-slate-700 text-slate-200 break-words">{notice}</div>
          )}

          {form ? (
            <ConnectionForm
              services={services}
              reconnect={form.reconnect}
              onDone={() => {
                setForm(null);
                void refresh();
              }}
              onBack={() => setForm(null)}
            />
          ) : (
            <>
              <p className="text-slate-400">{tc.intro}</p>
              {loading && connections.length === 0 && <p className="text-slate-500">{t.common.loading}</p>}
              {!loading && connections.length === 0 && <p className="text-slate-500" data-testid="connections-empty">{tc.empty}</p>}
              <ul className="space-y-2">
                {connections.map((c) => (
                  <li key={c.id} className="p-3 rounded-lg border border-ph-line bg-ph-panel" data-testid={`connection-${c.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-100 truncate">{c.label}</span>
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] ${STATUS_CLASS[c.status]}`}>{tc.status[c.status]}</span>
                          <span className="px-1.5 py-0.5 rounded border border-slate-700 text-[10px] text-slate-400">{tc.methods[c.method]}</span>
                        </div>
                        <div className="text-slate-400 truncate">
                          {tc.serviceLabels[c.serviceId] ?? c.serviceLabel} · {hostOf(c.baseUrl)}
                          {c.account?.login || c.account?.name ? ` · ${c.account.login ?? c.account.name}` : ''}
                        </div>
                        {c.scopes.length > 0 && <div className="text-slate-500">{fill(tc.scopesGranted, { list: c.scopes.join(', ') })}</div>}
                        {c.statusDetail && c.status !== 'connected' && <div className="text-amber-300/80 break-words">{c.statusDetail}</div>}
                        <div className="text-slate-500">
                          {c.usedBy.length > 0 ? fill(tc.usedBy, { list: c.usedBy.join(', ') }) : tc.notUsed}
                          {c.expiresAt ? ` · ${fill(c.hasRefreshToken ? tc.expiresRefresh : tc.expires, { time: new Date(c.expiresAt).toLocaleString() })}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {busy === c.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                        <IconButton title={tc.check} onClick={() => handleCheck(c)} disabled={busy !== null}>
                          <RefreshCw className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton title={tc.rename} onClick={() => handleRename(c)} disabled={busy !== null}>
                          <Pencil className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton title={tc.remove} onClick={() => handleRemove(c)} disabled={busy !== null} danger>
                          <Trash2 className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    </div>
                    {(c.status === 'needsReauth' || c.status === 'error') && (
                      <button
                        type="button"
                        onClick={() => setForm({ reconnect: c })}
                        className="mt-2 px-2.5 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-600 text-white text-[11px]"
                      >
                        {tc.reconnect}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setForm({})}
                data-testid="connections-add"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                <Plus className="w-3.5 h-3.5" />
                {tc.add}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

const IconButton: React.FC<{ title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({
  title,
  onClick,
  disabled,
  danger,
  children
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}
    className={`p-1.5 rounded-lg transition disabled:opacity-40 ${
      danger ? 'text-slate-400 hover:text-rose-300 hover:bg-rose-950/40' : 'text-slate-400 hover:text-white hover:bg-slate-800'
    }`}
  >
    {children}
  </button>
);

interface ConnectionFormProps {
  services: ConnectionServiceInfo[];
  reconnect?: ConnectionView;
  onDone: () => void;
  onBack: () => void;
}

const ConnectionForm: React.FC<ConnectionFormProps> = ({ services, reconnect, onDone, onBack }) => {
  const { t } = useTranslation();
  const tc = t.connections;
  const flows = useConnectionsStore((s) => s.flows);
  const [serviceId, setServiceId] = useState(reconnect?.serviceId ?? services[0]?.id ?? '');
  const service = services.find((s) => s.id === serviceId);
  const [method, setMethod] = useState<ConnectionAuthMethod>(reconnect?.method ?? service?.methods[0] ?? 'token');
  const [baseUrl, setBaseUrl] = useState(reconnect?.baseUrl ?? '');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState(reconnect?.username ?? '');
  const [clientId, setClientId] = useState(reconnect?.oauthClientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectPort, setRedirectPort] = useState(reconnect?.redirectPort ? String(reconnect.redirectPort) : '');
  const [scopes, setScopes] = useState<string[]>(reconnect?.scopes ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const flow: ConnectionFlowView | undefined = flowId ? flows[flowId] : undefined;

  // Смена сервиса: первый способ входа и права по умолчанию.
  const pickService = (id: string) => {
    const next = services.find((s) => s.id === id);
    setServiceId(id);
    if (next && !next.methods.includes(method)) setMethod(next.methods[0]);
    setScopes([]);
    setError(null);
  };

  const effectiveScopes = useMemo(() => {
    if (!service) return [];
    const known = new Set(service.scopes.map((s) => s.id));
    const picked = scopes.filter((s) => known.has(s));
    return picked.length > 0 ? picked : service.scopes.filter((s) => s.default).map((s) => s.id);
  }, [service, scopes]);

  const doneRef = useRef(false);
  useEffect(() => {
    if (flow?.state !== 'done' || doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [flow?.state, onDone]);

  if (!service) return null;
  const isOAuth = method === 'oauth-browser' || method === 'oauth-device';
  const secretRequired = Boolean(service.clientSecretRequired[method]);
  const needsClientId = isOAuth && !service.builtinClientId;
  const port = Number(redirectPort);
  const redirectUri = `http://127.0.0.1${port > 0 ? `:${port}` : ''}/callback`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const input: ConnectionInput = {
      serviceId,
      method,
      label: label.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      scopes: isOAuth ? effectiveScopes : undefined,
      token: isOAuth ? undefined : token,
      username: method === 'basic' ? username : undefined,
      clientId: isOAuth ? clientId.trim() || undefined : undefined,
      clientSecret: isOAuth ? clientSecret.trim() || undefined : undefined,
      redirectPort: method === 'oauth-browser' && port > 0 ? port : undefined
    };
    try {
      if (isOAuth) {
        const started = await window.api.connections.startOAuth(input, reconnect?.id);
        useConnectionsStore.getState().setFlow(started);
        setFlowId(started.flowId);
      } else {
        await window.api.connections.addToken(input, reconnect?.id);
        setToken('');
        onDone();
      }
    } catch (err) {
      setError(ipcErrorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (flow && flow.state !== 'done') {
    return <FlowPanel flow={flow} onBack={() => setFlowId(null)} />;
  }

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="connection-form">
      <h3 className="text-sm font-semibold text-slate-100">{reconnect ? fill(tc.form.titleReconnect, { name: reconnect.label }) : tc.form.titleAdd}</h3>

      {!reconnect && (
        <div>
          <label className="block text-slate-300 mb-1">{tc.form.service}</label>
          <div className="flex flex-wrap gap-1.5">
            {services.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pickService(s.id)}
                data-testid={`connection-service-${s.id}`}
                className={`px-2.5 py-1 rounded-lg border ${
                  s.id === serviceId ? 'border-indigo-400 bg-indigo-500/10 text-white' : 'border-ph-line text-slate-400 hover:text-slate-200'
                }`}
              >
                {tc.serviceLabels[s.id] ?? s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="block text-slate-300 mb-1">{tc.form.method}</label>
        <div className="flex flex-wrap gap-1.5">
          {service.methods.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              data-testid={`connection-method-${m}`}
              className={`px-2.5 py-1 rounded-lg border ${
                m === method ? 'border-indigo-400 bg-indigo-500/10 text-white' : 'border-ph-line text-slate-400 hover:text-slate-200'
              }`}
            >
              {tc.methods[m]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-slate-500">{tc.methodHints[method]}</p>
      </div>

      {service.selfHosted && (
        <div>
          <label className="block text-slate-300 mb-1">{tc.form.baseUrl}</label>
          <input
            className={inputClass}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={service.defaultBaseUrl ?? 'https://'}
            data-testid="connection-base-url"
          />
          <p className="mt-1 text-slate-500">{tc.form.baseUrlHint}</p>
        </div>
      )}

      {method === 'basic' && (
        <div>
          <label className="block text-slate-300 mb-1">{service.usernameHint === 'email' ? tc.form.usernameEmail : tc.form.username}</label>
          <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-testid="connection-username" />
        </div>
      )}

      {!isOAuth && (
        <div>
          <label className="block text-slate-300 mb-1">{method === 'basic' ? tc.form.password : service.tokenHint === 'webhook' ? tc.form.webhookLabel : tc.form.token}</label>
          <input
            className={inputClass}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            data-testid="connection-token"
          />
          {service.tokenHint && <p className="mt-1 text-slate-500">{tc.form.tokenHints[service.tokenHint]}</p>}
          {service.tokenHelpUrl && (
            <button type="button" onClick={() => openLink(service.tokenHelpUrl)} className="mt-1 flex items-center gap-1 text-indigo-300 hover:text-indigo-200">
              <ExternalLink className="w-3 h-3" />
              {tc.form.tokenHelp}
            </button>
          )}
        </div>
      )}

      {isOAuth && (
        <>
          {needsClientId && (
            <div>
              <label className="block text-slate-300 mb-1">client_id</label>
              <input className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" data-testid="connection-client-id" />
              <p className="mt-1 text-slate-500">{method === 'oauth-device' ? tc.form.clientIdHintDevice : fill(tc.form.clientIdHint, { uri: redirectUri })}</p>
              {service.oauthAppHelpUrl && (
                <button type="button" onClick={() => openLink(service.oauthAppHelpUrl)} className="mt-1 flex items-center gap-1 text-indigo-300 hover:text-indigo-200">
                  <ExternalLink className="w-3 h-3" />
                  {tc.form.oauthAppHelp}
                </button>
              )}
            </div>
          )}
          {(method === 'oauth-browser' || secretRequired) && (
            <div>
              <label className="block text-slate-300 mb-1">
                client_secret {secretRequired ? '' : `(${tc.form.optional})`}
              </label>
              <input
                className={inputClass}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                placeholder={reconnect?.hasClientSecret ? tc.form.clientSecretKept : ''}
                data-testid="connection-client-secret"
              />
              {secretRequired && <p className="mt-1 text-slate-500">{tc.form.clientSecretWhy}</p>}
            </div>
          )}
          {method === 'oauth-browser' && (
            <div>
              <label className="block text-slate-300 mb-1">{tc.form.redirectPort} ({tc.form.optional})</label>
              <input
                className={`${inputClass} max-w-[8rem]`}
                value={redirectPort}
                onChange={(e) => setRedirectPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                placeholder="—"
              />
              <p className="mt-1 text-slate-500">{tc.form.redirectPortHint}</p>
            </div>
          )}
          {service.scopes.length > 0 && (
            <div>
              <label className="block text-slate-300 mb-1">{tc.form.scopes}</label>
              <div className="space-y-1">
                {service.scopes.map((s) => (
                  <label key={s.id} className="flex items-start gap-2 text-slate-300">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={effectiveScopes.includes(s.id)}
                      onChange={(e) => {
                        const next = new Set(effectiveScopes);
                        if (e.target.checked) next.add(s.id);
                        else next.delete(s.id);
                        setScopes([...next]);
                      }}
                    />
                    <span>
                      <code className="text-indigo-200">{s.id}</code> — {tc.scopes[`${service.id}:${s.id}`] ?? s.id}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-slate-400" data-testid="connection-scopes-requested">
                {fill(tc.form.scopesRequested, { list: effectiveScopes.join(', ') || '—' })}
              </p>
            </div>
          )}
        </>
      )}

      {!reconnect && (
        <div>
          <label className="block text-slate-300 mb-1">{tc.form.label} ({tc.form.optional})</label>
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tc.form.labelPlaceholder} />
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-200 flex items-start gap-2" data-testid="connection-error">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          data-testid="connection-submit"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white"
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {isOAuth ? tc.form.submitOAuth : tc.form.submitToken}
        </button>
        <button type="button" onClick={onBack} className="px-3 py-1.5 rounded-lg text-slate-300 hover:bg-slate-800">
          {tc.form.back}
        </button>
      </div>
    </form>
  );
};

const FlowPanel: React.FC<{ flow: ConnectionFlowView; onBack: () => void }> = ({ flow, onBack }) => {
  const { t } = useTranslation();
  const tc = t.connections;
  const [copied, setCopied] = useState(false);
  const active = flow.state === 'pending' || flow.state === 'exchanging';

  return (
    <div className="space-y-3" data-testid="connection-flow">
      {flow.method === 'oauth-device' && flow.userCode && flow.state === 'pending' && (
        <>
          <p className="text-slate-300">{tc.flow.deviceInstruction}</p>
          <div className="flex items-center gap-2">
            <code className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-lg tracking-widest text-white" data-testid="connection-user-code">
              {flow.userCode}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(flow.userCode ?? '');
                setCopied(true);
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ph-line text-slate-300 hover:text-white"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? tc.flow.copied : tc.flow.copyCode}
            </button>
          </div>
          {flow.verificationUri && <p className="text-slate-500 break-all">{flow.verificationUri}</p>}
        </>
      )}
      {flow.method === 'oauth-browser' && flow.state === 'pending' && (
        <>
          <p className="text-slate-300">{tc.flow.browserWaiting}</p>
          {flow.authorizeUrl && (
            <details className="text-slate-400">
              <summary className="cursor-pointer select-none">{tc.flow.browserManual}</summary>
              <div className="mt-1.5 flex items-start gap-2">
                <code className="flex-1 p-2 rounded-lg bg-slate-900 border border-slate-700 break-all select-all" data-testid="connection-authorize-url">
                  {flow.authorizeUrl}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(flow.authorizeUrl ?? '');
                    setCopied(true);
                  }}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ph-line text-slate-300 hover:text-white shrink-0"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? tc.flow.copied : tc.flow.copyCode}
                </button>
              </div>
            </details>
          )}
        </>
      )}
      {flow.state === 'exchanging' && (
        <p className="text-slate-300 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {tc.flow.exchanging}
        </p>
      )}
      {flow.state === 'pending' && (
        <p className="text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {fill(tc.flow.waitingUntil, { time: new Date(flow.expiresAt).toLocaleTimeString() })}
        </p>
      )}
      {flow.state === 'error' && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-200 break-words" data-testid="connection-flow-error">
          {fill(tc.flow.error, { error: tc.flow.reasons[flow.error ?? ''] ?? flow.error ?? '' })}
        </div>
      )}
      {flow.state === 'cancelled' && <p className="text-slate-400">{tc.flow.cancelled}</p>}
      {flow.state === 'done' && (
        <p className="text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {tc.flow.done}
        </p>
      )}

      <div className="flex items-center gap-2">
        {flow.state === 'pending' && (
          <button
            type="button"
            onClick={() => void window.api.connections.openFlowPage(flow.flowId)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {flow.method === 'oauth-device' ? tc.flow.openPage : tc.flow.browserOpenAgain}
          </button>
        )}
        {active ? (
          <button
            type="button"
            onClick={() => void window.api.connections.cancelFlow(flow.flowId)}
            className="px-3 py-1.5 rounded-lg text-slate-300 hover:bg-slate-800"
          >
            {tc.flow.cancel}
          </button>
        ) : (
          <button type="button" onClick={onBack} className="px-3 py-1.5 rounded-lg text-slate-300 hover:bg-slate-800">
            {tc.form.back}
          </button>
        )}
      </div>
    </div>
  );
};
