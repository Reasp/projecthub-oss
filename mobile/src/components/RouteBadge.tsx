import { CloudIcon, GlobeIcon, ShieldCheckIcon, WifiHighIcon } from '@phosphor-icons/react';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import { routeLabel } from '../protocol/remoteClient';
import { Badge } from './ui';

const ICONS: Record<EndpointKind, typeof WifiHighIcon> = {
  lan: WifiHighIcon,
  vpn: ShieldCheckIcon,
  tunnel: CloudIcon,
  relay: GlobeIcon
};

/** Каким путём идёт связь с ПК (TASK-140.9): локальная сеть, VPN, туннель или релей. Всегда E2EE. */
export function RouteBadge({ route }: { route: EndpointKind | null }) {
  if (!route) return null;
  const Icon = ICONS[route];
  return (
    <Badge>
      <Icon size={12} className="mr-1" />
      {routeLabel(route)} · E2EE
    </Badge>
  );
}
