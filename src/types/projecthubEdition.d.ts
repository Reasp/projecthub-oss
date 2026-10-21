// Виртуальные модули редакции сборки (scripts/vite-edition.mjs, decision-123 п. 3).
declare module 'virtual:projecthub-edition/main' {
  export const edition: 'open' | 'team';
  export const modules: unknown[];
}

declare module 'virtual:projecthub-edition/renderer' {
  export const edition: 'open' | 'team';
  export const modules: unknown[];
}
