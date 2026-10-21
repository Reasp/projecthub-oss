// Локальная identity для подписи Mac-сборки (TASK-198, decision-150).
//
// Ad-hoc подпись даёт designated requirement = cdhash, он меняется с каждой сборкой, и macOS («Локальная сеть»,
// микрофон) считает каждую сборку новым приложением. Самоподписанный сертификат даёт requirement
// «identifier … and certificate leaf = H"…"» — один и тот же у всех сборок на этой машине.
//
// Сертификат создаётся при первой сборке без участия человека: отдельная связка ключей в ~/.projecthub/codesign
// со случайным паролем рядом (0600), ключ доступен codesign без диалогов (partition list). Доверие сертификату не
// нужно: codesign подписывает и недоверенной identity, а osx-sign вызывается с identityValidation: false.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IDENTITY_NAME = 'ProjectHub Local Code Signing';
const SECURITY = '/usr/bin/security';
// Системный LibreSSL: его PKCS#12 по умолчанию читает `security import`; OpenSSL 3 из Homebrew — нет.
const OPENSSL = '/usr/bin/openssl';

function paths() {
  const dir = path.join(os.homedir(), '.projecthub', 'codesign');
  return {
    dir,
    keychain: path.join(dir, 'projecthub-codesign.keychain-db'),
    passwordFile: path.join(dir, 'keychain-password')
  };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** SHA-1 сертификата identity в связке или null. */
function findIdentityHash(keychain) {
  try {
    const out = run(SECURITY, ['find-certificate', '-c', IDENTITY_NAME, '-Z', keychain]);
    return out.match(/SHA-1 hash:\s*([0-9A-F]{40})/i)?.[1].toUpperCase() ?? null;
  } catch {
    return null;
  }
}

function createIdentity({ dir, keychain, passwordFile }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    run(SECURITY, ['delete-keychain', keychain]);
  } catch {
    // связки ещё нет
  }
  fs.rmSync(keychain, { force: true });
  const password = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  run(SECURITY, ['create-keychain', '-p', password, keychain]);
  run(SECURITY, ['set-keychain-settings', keychain]); // без автоблокировки по таймеру и сну

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-codesign-'));
  try {
    const cnf = path.join(tmp, 'codesign.cnf');
    fs.writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        '[dn]',
        `CN = ${IDENTITY_NAME}`,
        '[codesign]',
        'basicConstraints = critical,CA:false',
        'keyUsage = critical,digitalSignature',
        'extendedKeyUsage = critical,codeSigning',
        'subjectKeyIdentifier = hash',
        ''
      ].join('\n')
    );
    const key = path.join(tmp, 'key.pem');
    const cert = path.join(tmp, 'cert.pem');
    const p12 = path.join(tmp, 'identity.p12');
    const p12Password = crypto.randomBytes(12).toString('hex');
    run(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '7300', '-keyout', key, '-out', cert, '-config', cnf, '-extensions', 'codesign']);
    run(OPENSSL, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', IDENTITY_NAME, '-out', p12, '-passout', `pass:${p12Password}`]);
    run(SECURITY, ['import', p12, '-k', keychain, '-P', p12Password, '-T', '/usr/bin/codesign']);
    run(SECURITY, ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Identity для codesign: создаётся при первом вызове, дальше переиспользуется. Возвращает SHA-1 и путь связки. */
export function ensureLocalSigningIdentity() {
  const p = paths();
  let password = fs.existsSync(p.passwordFile) ? fs.readFileSync(p.passwordFile, 'utf-8').trim() : '';
  let hash = password && fs.existsSync(p.keychain) ? findIdentityHash(p.keychain) : null;
  if (!hash) {
    console.log(`  • создаю identity «${IDENTITY_NAME}» в ${p.keychain}`);
    createIdentity(p);
    password = fs.readFileSync(p.passwordFile, 'utf-8').trim();
    hash = findIdentityHash(p.keychain);
    if (!hash) throw new Error(`identity «${IDENTITY_NAME}» не появилась в ${p.keychain}`);
  }
  run(SECURITY, ['unlock-keychain', '-p', password, p.keychain]);
  return { hash, keychain: p.keychain, name: IDENTITY_NAME };
}
