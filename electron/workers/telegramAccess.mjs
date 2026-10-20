/**
 * Кто может управлять ботом Telegram: решать запросы HITL, подтверждать задачи, смотреть очередь (TASK-138.4,
 * decision-110). Список `allowedUsers` — id или логины через запятую. Без списка — только владелец: id его личного
 * чата из настроек совпадает с id пользователя. В чате команды (группе) без списка никто не может отвечать: иначе
 * одобрить действие агента мог бы любой участник группы или любой, кто нашёл бота.
 */
export function isTelegramUserAllowed(from, config) {
  if (!from || !from.id) return false;
  const list = String(config?.allowedUsers || '').trim();
  if (!list) return String(from.id) === String(config?.chatId || '');
  const allowed = list.split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (allowed.includes(String(from.id))) return true;
  return Boolean(from.username) && allowed.includes(String(from.username).toLowerCase());
}
