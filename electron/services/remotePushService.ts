import type { HitlRequest } from './hitlTypes.js';
import {
  encodePushPayload,
  hitlPushPayload,
  shouldSuppressPush,
  signGatewayRequest,
  type GatewayPushBody,
  type NotePushPayload,
  type PushHostEndpoint,
  type PushPayload,
  type PushRegistration
} from './remotePush.js';
import { encryptWebPush, parseWebPushKeys } from './webPushCrypto.js';

/**
 * Доставка зашифрованных push (TASK-140.3, [[decision-115]]). Хост шлёт уведомление только устройствам, у которых
 * push включён явно для этого ПК, и только когда человек не видит запрос сам. UnifiedPush — прямо на адрес
 * дистрибьютора, FCM и APNs — через шлюз `ph-push`, который видит только токен и шифртекст. Тело и токены в лог не
 * пишутся. Electron и сеть приходят через зависимости — сервис проверяется unit-тестами.
 */

export interface PushTarget {
  deviceId: string;
  registration: PushRegistration;
  canDecide: boolean;
}

export interface RemotePushDeps {
  now(): number;
  fetch(url: string, init: RequestInit): Promise<Response>;
  targets(): PushTarget[];
  hostId(): string;
  machineName(): string;
  endpoints(): PushHostEndpoint[];
  deviceOnline(deviceId: string): boolean;
  /** Окно ProjectHub в фокусе и сколько секунд ПК простаивает. */
  pcActivity(): { windowFocused: boolean; idleSeconds: number };
  /** Адрес шлюза `ph-push`; пустой — FCM и APNs недоступны. */
  gatewayUrl(): string;
  hostSigningKey(): Promise<{ hostKeyRaw: Buffer; privateKeyPem: string } | null>;
  log(message: string): void;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Не больше 30 push в минуту на устройство: агент в цикле не завалит телефон. */
const PER_DEVICE_PER_MINUTE = 30;
/** Уведомление о запросе живёт час: позже оно бесполезно. */
const PUSH_TTL_SEC = 3600;

export type PushDeliveryResult = { ok: true } | { ok: false; error: string; gone?: boolean };

export class RemotePushService {
  private sentAt = new Map<string, number[]>();
  /** Каким устройствам ушёл push о запросе: им же уходит «решено», чтобы уведомление исчезло. */
  private notified = new Map<string, Set<string>>();

  constructor(
    private readonly deps: RemotePushDeps,
    /** Сообщить хосту, что адрес или токен больше не действует (404/410) — регистрацию нужно снять. */
    private readonly onGone: (deviceId: string) => void = () => undefined
  ) {}

  private allow(deviceId: string): boolean {
    const now = this.deps.now();
    const recent = (this.sentAt.get(deviceId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= PER_DEVICE_PER_MINUTE) {
      this.sentAt.set(deviceId, recent);
      return false;
    }
    recent.push(now);
    this.sentAt.set(deviceId, recent);
    return true;
  }

  /** Новый запрос HITL: подробный push каждому устройству с включённым push, если человек не видит запрос сам. */
  async onHitlRequested(request: HitlRequest): Promise<void> {
    const activity = this.deps.pcActivity();
    for (const target of this.deps.targets()) {
      if (shouldSuppressPush({ ...activity, deviceOnline: this.deps.deviceOnline(target.deviceId) })) continue;
      if (!this.allow(target.deviceId)) continue;
      const payload = hitlPushPayload(request, {
        hostId: this.deps.hostId(),
        machineName: this.deps.machineName(),
        deviceId: target.deviceId,
        canDecide: target.canDecide,
        endpoints: this.deps.endpoints(),
        now: this.deps.now()
      });
      const res = await this.deliver(target, payload, request.id, 'high');
      if (res.ok) {
        const set = this.notified.get(request.id) ?? new Set<string>();
        set.add(target.deviceId);
        this.notified.set(request.id, set);
      }
    }
  }

  /** Запрос решён, истёк или отменён: убрать уведомление с телефонов, куда оно ушло. */
  async onHitlFinished(requestId: string): Promise<void> {
    const devices = this.notified.get(requestId);
    this.notified.delete(requestId);
    if (!devices) return;
    for (const target of this.deps.targets()) {
      if (!devices.has(target.deviceId)) continue;
      await this.deliver(target, { v: 1, t: 'hitl_done', hid: this.deps.hostId(), rid: requestId, ts: this.deps.now() }, requestId, 'normal');
    }
  }

  /**
   * Сообщение агента `projecthub_notify` (decision-117 п. 8): каждому устройству с включённым push, с тем же
   * подавлением, что у HITL, — открытое приложение увидит запись в ленте. Возвращает, скольким устройствам ушло.
   */
  async onNote(note: { id: string; text: string; level: NotePushPayload['lvl']; projectPath?: string; agent?: string }): Promise<number> {
    const activity = this.deps.pcActivity();
    let delivered = 0;
    for (const target of this.deps.targets()) {
      if (shouldSuppressPush({ ...activity, deviceOnline: this.deps.deviceOnline(target.deviceId) })) continue;
      if (!this.allow(target.deviceId)) continue;
      const payload: NotePushPayload = {
        v: 1,
        t: 'note',
        hid: this.deps.hostId(),
        host: this.deps.machineName(),
        nid: note.id,
        text: note.text,
        lvl: note.level,
        ...(note.projectPath ? { proj: projectName(note.projectPath) } : {}),
        ...(note.agent ? { agent: note.agent } : {}),
        ts: this.deps.now()
      };
      const res = await this.deliver(target, payload, note.id, note.level === 'error' || note.level === 'warning' ? 'high' : 'normal');
      if (res.ok) delivered += 1;
    }
    return delivered;
  }

  /** Проверка из приложения: push приходит, даже если приложение открыто. */
  async sendTest(target: PushTarget): Promise<PushDeliveryResult> {
    return this.deliver(target, { v: 1, t: 'test', hid: this.deps.hostId(), host: this.deps.machineName(), ts: this.deps.now() }, undefined, 'high');
  }

  private async deliver(target: PushTarget, payload: PushPayload, collapseKey: string | undefined, urgency: 'high' | 'normal'): Promise<PushDeliveryResult> {
    const reg = target.registration;
    const keys = parseWebPushKeys(reg.p256dh, reg.auth);
    if (!keys) return { ok: false, error: 'bad_keys' };
    const ciphertext = encryptWebPush(keys, encodePushPayload(payload));
    try {
      if (reg.kind === 'unifiedpush' && reg.endpoint) {
        // RFC 8030: шифртекст телом, без авторизации; переход по редиректу не нужен.
        const res = await this.deps.fetch(reg.endpoint, {
          method: 'POST',
          headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(PUSH_TTL_SEC), Urgency: urgency },
          body: new Uint8Array(ciphertext),
          redirect: 'manual'
        });
        return this.result(target.deviceId, res.status);
      }
      if ((reg.kind === 'fcm' || reg.kind === 'apns') && reg.token) {
        const gateway = this.deps.gatewayUrl().replace(/\/$/, '');
        if (!gateway) return { ok: false, error: 'no_gateway' };
        const key = await this.deps.hostSigningKey();
        if (!key) return { ok: false, error: 'no_host_key' };
        const body: GatewayPushBody = {
          kind: reg.kind,
          token: reg.token,
          payload: ciphertext.toString('base64url'),
          regId: reg.regId,
          ttl: PUSH_TTL_SEC,
          urgency,
          ...(collapseKey ? { collapseKey } : {})
        };
        const json = JSON.stringify(body);
        const res = await this.deps.fetch(`${gateway}/v1/push`, {
          method: 'POST',
          headers: signGatewayRequest(json, key.hostKeyRaw, key.privateKeyPem, this.deps.now()),
          body: json,
          redirect: 'manual'
        });
        return this.result(target.deviceId, res.status);
      }
      return { ok: false, error: 'bad_registration' };
    } catch (err) {
      // Адрес и токен — секрет устройства: в лог только вид доставки и причина.
      this.deps.log(`[Push] ${reg.kind} delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'network' };
    }
  }

  private result(deviceId: string, status: number): PushDeliveryResult {
    if (status >= 200 && status < 300) return { ok: true };
    // 404/410 — дистрибьютор или вендор забыл адрес: регистрация больше не нужна.
    if (status === 404 || status === 410) {
      this.onGone(deviceId);
      return { ok: false, error: `http_${status}`, gone: true };
    }
    this.deps.log(`[Push] delivery rejected: HTTP ${status}`);
    return { ok: false, error: `http_${status}` };
  }
}
