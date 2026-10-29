// Хук electron-builder afterPack: до подписи даёт главному исполняемому файлу ProjectHub.app собственный LC_UUID
// (TASK-198, decision-150) и убирает нативные файлы чужой архитектуры (TASK-222, decision-178).
// Для Windows и Linux ничего не делает.

import fs from 'node:fs';
import path from 'node:path';
import { readMachOUuids, setMachOUuids, stableAppUuid } from './macho-uuid.mjs';
import { pruneArchFor, pruneForeignArch } from '../release/mac-natives.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return;
  const { productFilename, id: appId } = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  const buf = fs.readFileSync(exe);
  const before = readMachOUuids(buf);
  const replaced = setMachOUuids(buf, (cputype) => stableAppUuid(appId, cputype));
  if (replaced === 0) throw new Error(`${exe}: нет LC_UUID — «Локальная сеть» macOS не отличит ProjectHub от Electron`);
  fs.writeFileSync(exe, buf);
  const after = readMachOUuids(buf);
  console.log(`  • LC_UUID ${path.basename(exe)}: ${before.map((u) => u.uuid).join(', ')} → ${after.map((u) => u.uuid).join(', ')}`);

  // Временные приложения универсальной сборки не обрезаются: `@electron/universal` склеивает одинаковые наборы файлов.
  const arch = pruneArchFor(context.appOutDir, context.arch);
  if (arch) {
    const removed = pruneForeignArch(path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources'), arch);
    console.log(`  • ${arch}: убраны нативные файлы другой архитектуры (${removed.length})`);
  }
}
