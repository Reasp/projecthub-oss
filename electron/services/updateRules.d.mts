/** Типы для `updateRules.mjs` (TASK-147.4, decision-189). */
import type { KeyObject } from 'node:crypto';

export const UPDATE_FORMAT: 'projecthub-update/1';
export const UPDATE_MANIFEST_SUFFIX: '.update.json';

export interface UpdateManifestFields {
  format: 'projecthub-update/1';
  version: string;
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  file: string;
  size: number;
  sha256: string;
  releasedAt: string;
}

export interface UpdateManifest extends UpdateManifestFields {
  keyId: string;
  signature: string;
}

export type UpdateErrorCode =
  | 'update.manifestInvalid'
  | 'update.noTrustedKeys'
  | 'update.untrustedKey'
  | 'update.badSignature'
  | 'update.wrongPlatform'
  | 'update.notNewer';

export type UpdateVerdict = { ok: true; manifest: UpdateManifest } | { ok: false; code: UpdateErrorCode; params?: Record<string, string> };

export const INSTALLER_EXTENSIONS: { win32: '.exe'; darwin: '.dmg'; linux: '.AppImage' };
export function canonicalJson(value: unknown): string;
export function updateKeyId(publicKey: string | KeyObject): string;
export function compareVersions(a: string, b: string): number | null;
export function isPlainFileName(name: unknown): boolean;
export function buildUpdateManifest(fields: Omit<UpdateManifestFields, 'format' | 'releasedAt'> & { releasedAt?: string }): UpdateManifestFields;
export function signUpdateManifest(fields: UpdateManifestFields, privateKey: string | KeyObject): UpdateManifest;
export function verifyUpdateManifest(
  raw: unknown,
  ctx: { trustedKeys: ReadonlyArray<{ id: string; publicKey: string }>; currentVersion: string; platform: string; arch: string }
): UpdateVerdict;
