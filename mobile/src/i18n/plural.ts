/** Формы числа для словарей: `pluralRu(5, 'задача', 'задачи', 'задач')` → «задач». */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function pluralEn(n: number, one: string, other: string): string {
  return Math.abs(n) === 1 ? one : other;
}
