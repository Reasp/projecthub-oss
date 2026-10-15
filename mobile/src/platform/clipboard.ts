/**
 * Копирование в буфер обмена на телефоне (TASK-140.10). `navigator.clipboard` есть только в защищённом
 * контексте (приложение `http://localhost`, туннель по HTTPS, Telegram); иначе — запасной путь через
 * скрытое поле и `execCommand('copy')`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // нет разрешения или не защищённый контекст — пробуем запасной путь
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
