/**
 * Сканер QR сопряжения внутри приложения (TASK-140.8). Системная камера открыла бы ссылку из QR
 * в браузере, а не в приложении. Камера — `getUserMedia` WebView (разрешение запрашивает
 * Capacitor). Распознавание — `BarcodeDetector` платформы, если он есть, иначе `jsqr`: это
 * декодер картинки без криптографии, грузится лениво только при сканировании.
 *
 * Оверлей рисуется напрямую в `document.body` (z-[9999], как модальные окна по decision-17).
 */

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

function nativeDetector(): DetectorLike | null {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => DetectorLike }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export function isCameraScanAvailable(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && globalThis.isSecureContext !== false;
}

export function scanQrWithCamera(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9999] flex flex-col bg-black';
    overlay.innerHTML = `
      <video playsinline muted class="min-h-0 flex-1 object-cover"></video>
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div class="h-64 w-64 rounded-2xl border-2 border-white/80"></div>
      </div>
      <div class="absolute inset-x-0 top-0 px-4 pt-[calc(env(safe-area-inset-top)+16px)] text-center text-[15px] text-white">Наведите камеру на QR-код в ProjectHub</div>
      <div class="absolute inset-x-0 bottom-0 flex justify-center pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <button type="button" class="h-12 rounded-xl bg-white/15 px-6 text-[15px] font-medium text-white">Отмена</button>
      </div>`;
    document.body.appendChild(overlay);
    const video = overlay.querySelector('video')!;
    const cancel = overlay.querySelector('button')!;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream: MediaStream | null = null;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));

    const detector = nativeDetector();
    let jsQr: ((data: Uint8ClampedArray, w: number, h: number) => { data: string } | null) | null = null;

    const tick = async () => {
      if (done) return;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes[0]?.rawValue) return finish(codes[0].rawValue);
          } else if (ctx) {
            if (!jsQr) jsQr = (await import('jsqr')).default;
            const w = Math.min(960, video.videoWidth);
            const h = Math.round((video.videoHeight / video.videoWidth) * w);
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const code = jsQr(ctx.getImageData(0, 0, w, h).data, w, h);
            if (code?.data) return finish(code.data);
          }
        }
      } catch {
        // кадр не распознан — пробуем следующий
      }
      timer = setTimeout(() => void tick(), 180);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (done) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        await video.play().catch(() => undefined);
        void tick();
      })
      .catch(() => {
        alert('Нет доступа к камере. Разрешите камеру для ProjectHub в настройках телефона или вставьте ссылку сопряжения.');
        finish(null);
      });
  });
}
