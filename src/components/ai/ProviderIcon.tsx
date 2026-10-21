import React from 'react';
import { HardDrive, Server } from '../common/icons';
import { BrandLogo } from '../common/BrandLogo';
import type { ConnectionIcon } from '../../lib/connections';

/** Значок провайдера подключения (TASK-172): логотип сервиса, локальный сервер или сервер. */
export const ProviderIcon: React.FC<{ icon: ConnectionIcon; className?: string }> = ({ icon, className = 'w-4 h-4' }) => {
  if (icon === 'local') return <HardDrive className={`${className} text-emerald-400`} />;
  if (icon === 'server') return <Server className={`${className} text-slate-400`} />;
  return <BrandLogo name={icon} className={`${className} ${icon === 'anthropic' || icon === 'ollama' ? 'text-slate-100' : ''}`} />;
};
