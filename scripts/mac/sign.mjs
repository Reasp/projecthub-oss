// Своя подпись Mac-сборки для electron-builder (`build.mac.sign`, TASK-198, decision-150).
//
// Подписывает стабильной локальной identity (codesign-identity.mjs) вместо ad-hoc. electron-builder доходит до этой
// функции и без найденной Apple identity: identity и связку подставляем здесь, проверку identity osx-sign отключаем.
// Не вышло — откат на ad-hoc с заметным предупреждением: сборка не ломается, но «Локальная сеть» будет сбрасываться.

import { execFileSync } from 'node:child_process';
import { signAsync } from '@electron/osx-sign';
import { ensureLocalSigningIdentity } from './codesign-identity.mjs';

function designatedRequirement(app) {
  return execFileSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n')
    .find((line) => line.startsWith('designated'));
}

async function signWithLocalIdentity(opts) {
  const identity = ensureLocalSigningIdentity();
  await signAsync({ ...opts, identity: identity.hash, keychain: identity.keychain, identityValidation: false });
  const requirement = designatedRequirement(opts.app) ?? '';
  if (!requirement.includes('certificate leaf')) throw new Error(`подпись не стабильна: ${requirement || 'нет designated requirement'}`);
  console.log(`  • подписано «${identity.name}» (${identity.hash.slice(0, 8)}…): ${requirement}`);
}

export default async function sign(opts) {
  try {
    await signWithLocalIdentity(opts);
  } catch (err) {
    console.warn(
      [
        '',
        '⚠️  Подпись локальной identity не удалась — подписываю ad-hoc.',
        '   «Локальная сеть» macOS будет требовать разрешение заново после каждой пересборки.',
        `   Причина: ${err instanceof Error ? err.message : String(err)}`,
        ''
      ].join('\n')
    );
    await signAsync({ ...opts, identity: '-', identityValidation: false });
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', opts.app], { stdio: 'inherit' });
}
