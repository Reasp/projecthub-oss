// LC_UUID главного исполняемого файла Mac-сборки (TASK-198, decision-150).
//
// «Локальная сеть» macOS узнаёт приложение по UUID главного Mach-O (TN3179). electron-builder кладёт в
// ProjectHub.app неизменённый бинарник Electron: UUID у него тот же, что у Electron.app из node_modules и у любого
// приложения на этой версии Electron, и система путает их записи. Здесь — разбор Mach-O без зависимостей и замена
// UUID на собственный, стабильный между сборками.

import { createHash } from 'node:crypto';

export const LC_UUID = 0x1b;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

/** Срезы Mach-O: у тонкого файла один, у универсального — по одному на архитектуру. */
export function machOSlices(buf) {
  if (buf.length < 8) throw new Error('Не Mach-O: файл короче заголовка');
  const fatMagic = buf.readUInt32BE(0);
  if (fatMagic === FAT_MAGIC || fatMagic === FAT_MAGIC_64) {
    const is64 = fatMagic === FAT_MAGIC_64;
    const count = buf.readUInt32BE(4);
    const entrySize = is64 ? 32 : 20;
    const slices = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * entrySize;
      if (at + entrySize > buf.length) throw new Error('Не Mach-O: таблица архитектур обрезана');
      const offset = is64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
      slices.push({ cputype: buf.readInt32BE(at), offset });
    }
    return slices;
  }
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) throw new Error('Не Mach-O: неизвестная сигнатура');
  return [{ cputype: buf.readInt32LE(4), offset: 0 }];
}

/** Смещения 16 байт UUID в срезе; заголовок little-endian (arm64, x86_64). */
function uuidOffsets(buf, sliceOffset) {
  const magic = buf.readUInt32LE(sliceOffset);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) throw new Error(`Не Mach-O: срез по смещению ${sliceOffset}`);
  const headerSize = magic === MH_MAGIC_64 ? 32 : 28;
  const ncmds = buf.readUInt32LE(sliceOffset + 16);
  const offsets = [];
  let at = sliceOffset + headerSize;
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > buf.length) throw new Error('Не Mach-O: команды загрузки обрезаны');
    const cmd = buf.readUInt32LE(at);
    const cmdsize = buf.readUInt32LE(at + 4);
    if (cmdsize < 8) throw new Error('Не Mach-O: команда загрузки нулевой длины');
    if (cmd === LC_UUID) offsets.push(at + 8);
    at += cmdsize;
  }
  return offsets;
}

export function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID всех срезов в формате dwarfdump --uuid. */
export function readMachOUuids(buf) {
  return machOSlices(buf).flatMap(({ cputype, offset }) =>
    uuidOffsets(buf, offset).map((at) => ({ cputype, uuid: formatUuid(buf.subarray(at, at + 16)) }))
  );
}

/** Заменяет UUID каждого среза на uuidFor(cputype) прямо в buf; возвращает число замен. */
export function setMachOUuids(buf, uuidFor) {
  let replaced = 0;
  for (const { cputype, offset } of machOSlices(buf)) {
    for (const at of uuidOffsets(buf, offset)) {
      const uuid = uuidFor(cputype);
      if (uuid.length !== 16) throw new Error('UUID должен быть 16 байт');
      uuid.copy(buf, at);
      replaced++;
    }
  }
  return replaced;
}

/**
 * UUID приложения: SHA-256 от appId и архитектуры, биты версии 5 и варианта RFC 4122. Одинаков у всех сборок
 * одного приложения — запись «Локальной сети» переживает пересборку; у разных архитектур разный, как у Xcode.
 */
export function stableAppUuid(appId, cputype) {
  const bytes = createHash('sha256').update(`projecthub-mac-uuid\0${appId}\0${cputype}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Buffer.from(bytes);
}
