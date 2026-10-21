import type { Plugin } from 'vite';

export type Edition = 'open' | 'team';
export type EditionTarget = 'main' | 'renderer';

export function resolveEdition(root: string, env?: Record<string, string | undefined>): Edition;
export function findEditionModules(root: string, target: EditionTarget): string[];
export function editionModuleSource(edition: Edition, entries: string[]): string;
export function projecthubEdition(options?: { root?: string; env?: Record<string, string | undefined> }): Plugin;
