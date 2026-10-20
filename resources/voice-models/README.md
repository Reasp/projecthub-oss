# Модели подготовки звука перед распознаванием

Кладутся в сборку как `resources/voice-models` (extraResources), используются процессом
`electron/workers/speechWorker.mjs` (TASK-164.2, decision-94). Источник — релизы
[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/releases).

| Файл | Что это | Лицензия | Источник | SHA-256 |
|---|---|---|---|---|
| `silero_vad.onnx` | Silero VAD — детектор речи | MIT, Silero Team | `asr-models/silero_vad.onnx` | `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6` |
| `gtcrn_simple.onnx` | GTCRN — лёгкий шумодав, 16 кГц | MIT, Rong Xiaobin | `speech-enhancement-models/gtcrn_simple.onnx` | `e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534` |
