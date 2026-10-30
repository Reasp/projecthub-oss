package com.projecthub.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Подписанный ответ хоста на кнопку уведомления (TASK-252, decision-192). Хост подписывает итог тем же ключом кнопок
 * (`pushActionReplyMac`): кнопку (устройство, запрос, решение, способ, время нажатия), код HTTP и итог. Посредник в
 * LAN или с пользовательским центром сертификации без ключа не выдаст отказ или потерянный запрос за «одобрено».
 * Без Android — проверяется JVM-тестом.
 */
final class PushReply {
    static final String LABEL = "projecthub-push-action-reply-v1";

    private PushReply() {}

    /**
     * Итог для подписи: `ok` у 200, иначе причина, код `reasonKey` и имя участника — всё, из чего собирается текст
     * отказа (`pushActionReplyOutcome` на хосте). Нет поля — пустая строка.
     */
    static String outcome(int status, String reason, String code, String member) {
        if (status == 200) return "ok";
        return nz(reason) + "\n" + nz(code) + "\n" + nz(member);
    }

    private static String nz(String v) {
        return v == null ? "" : v;
    }

    /** Что показать по ответу хоста: проверен ли он, окончательный ли итог и его текст. */
    static final class Shown {
        final boolean verified;
        final boolean done;
        final String text;

        Shown(boolean verified, boolean done, String text) {
            this.verified = verified;
            this.done = done;
            this.text = text;
        }
    }

    /**
     * Итог кнопки по ответу одного адреса хоста. Без верной подписи — `verified=false` и «не подтвердил»: приёмник
     * пробует следующий адрес. С подписью — одобрено/отклонено у 200, текст отказа у 404/409, «не принял» у прочих.
     */
    static Shown shown(Texts t, byte[] actionKey, String signedPrefix, String decision, int status, String reason, String code, String member, String replyMac) {
        String signed = signedPrefix + "\n" + status + "\n" + outcome(status, reason, code, member);
        if (!verify(actionKey, signed, replyMac)) return new Shown(false, false, t.get(R.string.outcome_unconfirmed));
        if (status == 200) return new Shown(true, true, t.get("allow".equals(decision) ? R.string.outcome_approved : R.string.outcome_denied));
        if (status == 409 || status == 404) return new Shown(true, PushRefusal.isFinal(reason), PushRefusal.text(t, reason, code, member));
        return new Shown(true, false, t.get(R.string.outcome_rejected));
    }

    /** Начало подписанной строки: метка и кнопка (хост, устройство, запрос, решение, способ, время нажатия). */
    static String prefix(String hostId, String deviceId, String requestId, String decision, String confirm, long ts) {
        return LABEL + "\n" + hostId + "\n" + deviceId + "\n" + requestId + "\n" + decision + "\n" + confirm + "\n" + ts;
    }

    static String text(String hostId, String deviceId, String requestId, String decision, String confirm, long ts, int status, String outcome) {
        return prefix(hostId, deviceId, requestId, decision, confirm, ts) + "\n" + status + "\n" + outcome;
    }

    /** Подпись ответа верна. Пустая или повреждённая — нет. */
    static boolean verify(byte[] actionKey, String text, String replyMac) {
        if (actionKey == null || actionKey.length == 0 || replyMac == null || replyMac.isEmpty()) return false;
        try {
            byte[] expected = b64url(WebPush.actionMac(actionKey, text)).getBytes(StandardCharsets.US_ASCII);
            return MessageDigest.isEqual(expected, replyMac.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception e) {
            return false;
        }
    }

    private static final char[] ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    /** base64url без дополнения, как `digest('base64url')` на хосте (java.util.Base64 — только с API 26). */
    static String b64url(byte[] data) {
        StringBuilder out = new StringBuilder((data.length * 4 + 2) / 3);
        int i = 0;
        for (; i + 2 < data.length; i += 3) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff);
            out.append(ALPHABET[(n >> 18) & 63]).append(ALPHABET[(n >> 12) & 63]).append(ALPHABET[(n >> 6) & 63]).append(ALPHABET[n & 63]);
        }
        int rest = data.length - i;
        if (rest == 1) {
            int n = (data[i] & 0xff) << 16;
            out.append(ALPHABET[(n >> 18) & 63]).append(ALPHABET[(n >> 12) & 63]);
        } else if (rest == 2) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8);
            out.append(ALPHABET[(n >> 18) & 63]).append(ALPHABET[(n >> 12) & 63]).append(ALPHABET[(n >> 6) & 63]);
        }
        return out.toString();
    }
}
