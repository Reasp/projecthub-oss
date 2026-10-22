import React from 'react';
import { HardDrive, Server, Terminal } from '../common/icons';
import { BrandLogo } from '../common/BrandLogo';
import type { ConnectionIcon } from '../../lib/connections';

/** Значок провайдера подключения (TASK-172): логотип сервиса, локальный сервер или сервер. */
export const ProviderIcon: React.FC<{ icon: ConnectionIcon; className?: string }> = ({ icon, className = 'w-4 h-4' }) => {
  if (icon === 'local') return <HardDrive className={`${className} text-emerald-400`} />;
  if (icon === 'cli') return <Terminal className={`${className} text-sky-300`} />;
  if (icon === 'server') return <Server className={`${className} text-slate-400`} />;
  return <BrandLogo name={icon} className={`${className} ${icon === 'anthropic' || icon === 'ollama' ? 'text-slate-100' : ''}`} />;
};
