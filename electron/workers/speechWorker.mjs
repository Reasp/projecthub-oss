/**
 * Процесс подготовки звука фразы перед распознаванием (TASK-164.2, decision-94).
 *
 * Фраза приходит целиком, уже в 16 кГц; ответ — есть ли в ней речь и звук, очищенный шумодавом и
 * обрезанный до речи с запасом по краям. Так шум вентилятора, щелчки и стуки не попадают в Whisper,
 * который на них выдумывает текст. `recognize` сразу распознаёт подготовленную фразу локальной
 * моделью GigaAM (TASK-164.4). Сама обработка — в `speechPrep.mjs`.
 *
 * Отдельный `utilityProcess`, а не поток main, по тем же причинам, что и синтез Piper (decision-34):
 * у sherpa своя `onnxruntime.dll`, несовместимая с `onnxruntime-node` Whisper, а битая модель роняет
 * процесс целиком.
 */
import { createRequire } from 'node:module';
import { createSpeechPreparer } from './speechPrep.mjs';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('speechWorker.mjs must be run as an Electron utility process');
}

const require = createRequire(import.meta.url);
let sherpa = null;
const preparer = createSpeechPreparer(() => {
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  return sherpa;
});

parentPort.on('message', (event) => {
  const msg = event?.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'prepare' && msg.type !== 'recognize') return;
  try {
    const result = msg.type === 'recognize' ? preparer.recognize(msg) : preparer.prepare(msg);
    parentPort.postMessage({ type: 'prepared', id: msg.id, ...result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: err?.message || String(err) });
  }
});

parentPort.postMessage({ type: 'ready' });
