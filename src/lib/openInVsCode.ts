/**
 * Открыть путь в VS Code и сообщить пользователю, если не получилось (decision-73).
 * Раньше кнопки «VS Code» молча ничего не делали, когда команды `code` нет в PATH.
 */
export async function openInVsCode(path: string, onFail: (error?: string) => void): Promise<void> {
  if (!window.api?.openInCode) return;
  try {
    const result = await window.api.openInCode(path);
    if (result && !result.ok) onFail(result.error);
  } catch (err) {
    onFail(err instanceof Error ? err.message : String(err));
  }
}
