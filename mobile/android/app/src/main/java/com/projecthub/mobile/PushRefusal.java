package com.projecthub.mobile;

import java.util.Locale;

/**
 * Итог кнопки уведомления, когда хост отказал (`409`, TASK-216): код отказа или чужой запрос участника (`not_owner`,
 * decision-135). Для `not_owner` хост присылает в `reason` английский текст, а код — в `reasonKey` (decision-165):
 * `team.hitlOfOwner` или `team.hitlOfMember` с именем участника. Причина без известного кода — тоже чужой запрос:
 * так отвечал хост до decision-165. Без Android — проверяется JVM-тестом.
 */
final class PushRefusal {
    private PushRefusal() {}

    static String text(Texts t, String reason, String keyCode, String member) {
        if ("confirmation_required".equals(reason)) return t.get(R.string.outcome_confirm_in_app);
        if ("already_decided".equals(reason)) return t.get(R.string.outcome_already_decided);
        if (reason == null || reason.isEmpty() || "not_found".equals(reason) || "invalid_source".equals(reason)) {
            return t.get(R.string.outcome_not_found);
        }
        if ("team.hitlOfMember".equals(keyCode) && member != null && !member.trim().isEmpty()) {
            return String.format(Locale.ROOT, t.get(R.string.outcome_not_owner_member), member.trim());
        }
        if ("team.hitlOfOwner".equals(keyCode)) return t.get(R.string.outcome_not_owner_host);
        return t.get(R.string.outcome_not_owner);
    }

    /** Итог окончательный: уведомление можно убрать. Нужное подтверждение в приложении — нет. */
    static boolean isFinal(String reason) {
        return !"confirmation_required".equals(reason);
    }
}
