/**
 * Фильтр галлюцинаций Whisper (TASK-164.3). Whisper учился на субтитрах и на шуме или тишине
 * выдаёт не пустую строку, а подписи к звукам и титры: «ТРЕВОЖНАЯ МУЗЫКА», «Продолжение следует»,
 * «Субтитры сделал…», повтор одного слова. Такая фраза не должна уходить в разбор команд и диктовку.
 *
 * Шлюз Silero VAD (decision-94) отсекает большую часть шума до распознавания, фильтр — вторая линия:
 * VAD выключен, недоступен или пропустил стук, похожий на речь.
 */

/** Нормализация для сравнения: регистр, ё→е, без пунктуации и лишних пробелов. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Фраза целиком — подпись к звуку или служебный титр. */
const EXACT = new Set([
  'музыка',
  'тревожная музыка',
  'динамичная музыка',
  'спокойная музыка',
  'веселая музыка',
  'грустная музыка',
  'торжественная музыка',
  'музыкальная заставка',
  'аплодисменты',
  'смех',
  'шум',
  'тишина',
  'конец',
  'music',
  'applause',
  'laughter',
  'silence',
  'you',
  'thank you',
  'bye'
]);

/** Начало фразы, с которого Whisper пишет титры. */
const PREFIXES = [
  'субтитры',
  'редактор субтитров',
  'корректор',
  'продолжение следует',
  'спасибо за просмотр',
  'спасибо за внимание',
  'подписывайтесь на канал',
  'ставьте лайки',
  'до новых встреч',
  'thank you for watching',
  'thanks for watching',
  'subtitles by',
  'please subscribe'
];

/** Подпись к звуку целиком в скобках или звёздочках: «[музыка]», «(смех)», «*шум*», «♪». */
const BRACKETED = /^\s*(?:[[(*♪♫][^\])*]*[\])*♪♫]\s*)+$/u;

/**
 * Галлюцинация ли это. Словарные совпадения — только на фразу целиком или её начало: настоящая
 * команда «включи музыку» под фильтр не попадает.
 */
export function isLikelyHallucination(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (BRACKETED.test(raw)) return true;

  const norm = normalize(raw);
  if (!norm) return true;
  if (EXACT.has(norm)) return true;
  if (PREFIXES.some((prefix) => norm === prefix || norm.startsWith(`${prefix} `))) return true;

  // Подписи к звукам Whisper пишет капсом. В обычной речи весь текст заглавными не бывает,
  // а аббревиатуры («API», «CI») короче порога.
  const letters = raw.match(/\p{L}/gu) ?? [];
  if (letters.length >= 6 && !/\p{Ll}/u.test(raw)) return true;

  // Вырожденный повтор: «да да да да да», «и и и и».
  const words = norm.split(' ');
  if (words.length >= 4 && new Set(words).size / words.length <= 0.3) return true;

  return false;
}
