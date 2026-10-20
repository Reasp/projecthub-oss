/**
 * Чистая логика «шлюза речи» перед распознаванием (TASK-164.2, decision-94): по отрезкам, которые
 * нашёл Silero VAD, решает, есть ли в фразе речь, и какой кусок звука отдать распознавателю.
 * Без sherpa и Electron — чтобы покрываться unit-тестами.
 */

/** Запас до первой речи: VAD отмечает начало с задержкой, глухие согласные срезать нельзя. */
export const PAD_BEFORE_SEC = 0.25;
/** Запас после конца речи: окончания слов затухают тише порога VAD. */
export const PAD_AFTER_SEC = 0.2;

/**
 * Отрезки речи короче этого считаются щелчками и стуками, а не словами. Silero сам отбрасывает
 * отрезки короче `minSpeechDuration`, здесь — общая сумма: одна короткая вспышка ещё не фраза.
 */
export const MIN_TOTAL_SPEECH_SEC = 0.2;

/** Фразы не длиннее этого распознаются целиком; длиннее — кусками по паузам (GigaAM, TASK-164.4). */
export const MAX_SINGLE_PASS_SEC = 25;
/** Предел куска при нарезке длинной фразы. */
export const MAX_CHUNK_SEC = 20;

/**
 * Куски длинной фразы для распознавания по частям: соседние отрезки речи склеиваются, пока кусок
 * не длиннее `MAX_CHUNK_SEC`, а резы идут по паузам между ними. Отрезок длиннее предела режется
 * жёстко. Без отрезков (шлюз выключен) — равные куски.
 *
 * @param {Array<[number, number]>} segments отрезки речи `[начало, конец)` в сэмплах звука `total`
 * @param {number} total длина звука в сэмплах
 * @param {number} sampleRate частота дискретизации
 * @returns {Array<[number, number]>}
 */
export function planChunks(segments, total, sampleRate) {
  if (total <= MAX_SINGLE_PASS_SEC * sampleRate) return [[0, total]];
  const max = MAX_CHUNK_SEC * sampleRate;
  const cuts = [];
  const sorted = segments.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) {
    for (let start = 0; start < total; start += max) cuts.push([start, Math.min(total, start + max)]);
    return cuts;
  }
  let chunkStart = 0;
  let lastEnd = 0;
  for (const [start, end] of sorted) {
    // Отрезок не влезает в текущий кусок — режем по середине паузы перед ним
    if (end - chunkStart > max && lastEnd > chunkStart) {
      const cut = Math.round((lastEnd + start) / 2);
      cuts.push([chunkStart, cut]);
      chunkStart = cut;
    }
    while (end - chunkStart > max) {
      cuts.push([chunkStart, chunkStart + max]);
      chunkStart += max;
    }
    lastEnd = end;
  }
  if (chunkStart < total) cuts.push([chunkStart, total]);
  return cuts;
}

/**
 * Окно звука для распознавания: от начала первой речи до конца последней с запасом по краям.
 * Паузы между словами внутри окна сохраняются — распознавателю нужен связный звук фразы.
 *
 * @param {Array<[number, number]>} segments отрезки речи в сэмплах `[начало, конец)`
 * @param {number} totalSamples длина фразы в сэмплах
 * @param {number} sampleRate частота дискретизации
 * @returns {{ start: number, end: number, speechSec: number } | null} null — речи нет
 */
export function speechWindow(segments, totalSamples, sampleRate) {
  const valid = segments
    .map(([start, end]) => [Math.max(0, start), Math.min(totalSamples, end)])
    .filter(([start, end]) => end > start);
  if (valid.length === 0) return null;

  const speechSamples = valid.reduce((sum, [start, end]) => sum + (end - start), 0);
  const speechSec = speechSamples / sampleRate;
  if (speechSec < MIN_TOTAL_SPEECH_SEC) return null;

  const first = Math.min(...valid.map(([start]) => start));
  const last = Math.max(...valid.map(([, end]) => end));
  return {
    start: Math.max(0, first - Math.round(PAD_BEFORE_SEC * sampleRate)),
    end: Math.min(totalSamples, last + Math.round(PAD_AFTER_SEC * sampleRate)),
    speechSec
  };
}
