/**
 * Выбор адресов ПК для LAN Direct (TASK-140.8). Чистая функция без Electron.
 *
 * `os.networkInterfaces()` отдаёт адаптеры в порядке ОС, и первым часто идёт виртуальный или
 * отключённый адаптер с link-local адресом (`169.254.x.x` у Tailscale, VMware, Hyper-V). QR брал
 * первый адрес, и телефон стучался туда, где его никто не слушает. Порядок: частные сети
 * физических адаптеров (Wi-Fi, Ethernet) → частные сети виртуальных → CGNAT (Tailscale `100.64/10`)
 * → прочие. Link-local (`169.254/16`) отбрасывается: из другой сети он недостижим.
 */

export interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

const VIRTUAL_ADAPTER = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier|wireguard|loopback|bluetooth|vpn|tap|tun|utun|bridge|br-|virbr|veth/i;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

export function isLinkLocal(address: string): boolean {
  const p = ipv4Parts(address);
  return Boolean(p && p[0] === 169 && p[1] === 254);
}

export function isPrivateLan(address: string): boolean {
  const p = ipv4Parts(address);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function isCgnat(address: string): boolean {
  const p = ipv4Parts(address);
  return Boolean(p && p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

function score(name: string, address: string): number {
  const virtual = VIRTUAL_ADAPTER.test(name);
  if (isPrivateLan(address)) return virtual ? 2 : (/wi-?fi|wlan|wireless|ethernet|^en|^eth/i.test(name) ? 0 : 1);
  if (isCgnat(address)) return 3;
  return 4;
}

/** Оверлейные сети: через них телефон достаёт ПК из любой сети (TASK-140.9). */
const VPN_ADAPTER = /tailscale|headscale|zerotier|wireguard|^wg\d|netbird|nebula|openvpn|vpn|^utun|^tun/i;
/** Гипервизоры и контейнеры: адрес живёт только внутри ПК, телефону он бесполезен. */
const HOST_ONLY_ADAPTER = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|virbr|veth|br-|bridge|loopback|bluetooth/i;

/**
 * Адреса ПК для списка адресов телефона (TASK-140.9): `lan` — частные сети физических адаптеров,
 * `vpn` — CGNAT Tailscale/Headscale и адаптеры WireGuard/ZeroTier. Адреса гипервизоров, WSL и Docker
 * отбрасываются: с телефона до них не дойти. Порядок внутри вида — как у `rankLanAddresses`.
 */
export function classifyLanAddresses(interfaces: Record<string, InterfaceAddress[] | undefined>): Array<{ address: string; kind: 'lan' | 'vpn' }> {
  const kindByAddress = new Map<string, 'lan' | 'vpn' | null>();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const iface of list ?? []) {
      if (kindByAddress.has(iface.address)) continue;
      let kind: 'lan' | 'vpn' | null;
      if (isCgnat(iface.address) || VPN_ADAPTER.test(name)) kind = 'vpn';
      else if (HOST_ONLY_ADAPTER.test(name)) kind = null;
      else kind = isPrivateLan(iface.address) ? 'lan' : null;
      kindByAddress.set(iface.address, kind);
    }
  }
  return rankLanAddresses(interfaces)
    .map((address) => ({ address, kind: kindByAddress.get(address) ?? null }))
    .filter((a): a is { address: string; kind: 'lan' | 'vpn' } => a.kind !== null);
}

/** IPv4-адреса без loopback и link-local, лучший для телефона в той же Wi-Fi — первым. */
export function rankLanAddresses(interfaces: Record<string, InterfaceAddress[] | undefined>): string[] {
  const found: Array<{ address: string; score: number; order: number }> = [];
  let order = 0;
  for (const [name, list] of Object.entries(interfaces)) {
    for (const iface of list ?? []) {
      const ipv4 = iface.family === 'IPv4' || iface.family === 4;
      if (!ipv4 || iface.internal || isLinkLocal(iface.address) || !ipv4Parts(iface.address)) continue;
      found.push({ address: iface.address, score: score(name, iface.address), order: order++ });
    }
  }
  found.sort((a, b) => a.score - b.score || a.order - b.order);
  return [...new Set(found.map((f) => f.address))];
}
