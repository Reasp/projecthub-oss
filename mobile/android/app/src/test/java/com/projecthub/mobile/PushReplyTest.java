package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

import org.junit.BeforeClass;
import org.junit.Test;

/** Подпись ответа хоста на кнопку уведомления совпадает с `pushActionReplyMac` хоста (TASK-252, decision-192). */
public class PushReplyTest {
    private static final byte[] KEY = "Jefe".getBytes(StandardCharsets.UTF_8);
    // Векторы посчитаны на хосте: pushActionReplyMac(base64url("Jefe"), "ph_h", кнопка, статус, итог).
    private static final String OK_200 = "N_EQ8lI-R6A-2WZQJ0ZF2X1lAiTATwNpyCDI8oiEk8A";
    private static final String DECIDED_409 = "umtk-ceI1ZeuvwtqZABgP9l3c5AwuI9HVNXkslidUgY";
    private static final String ANNA_409 = "ha2Aggy9bzyxDtR6p4LOyjvbT59c5i31UFEomT2VEL4";
    private static final String PREFIX = PushReply.prefix("ph_h", "android_1", "r1", "allow", "notification", 1_000_000L);

    private static Texts ru;

    @BeforeClass
    public static void load() throws Exception {
        ru = ResTexts.load("values-ru");
    }

    private static String text(int status, String outcome) {
        return PushReply.text("ph_h", "android_1", "r1", "allow", "notification", 1_000_000L, status, outcome);
    }

    @Test
    public void verifiesTheHostSignatureOfSuccessAndRefusal() {
        assertTrue(PushReply.verify(KEY, text(200, PushReply.outcome(200, "x", null, null)), OK_200));
        assertTrue(PushReply.verify(KEY, text(409, PushReply.outcome(409, "already_decided", null, null)), DECIDED_409));
        // Кириллица в имени участника кодируется одинаково на хосте и телефоне.
        assertTrue(PushReply.verify(KEY, text(409, PushReply.outcome(409, "Owned by Анна", "team.hitlOfMember", "Анна")), ANNA_409));
    }

    @Test
    public void refusesAMissingForgedOrMovedSignature() {
        assertFalse(PushReply.verify(KEY, text(200, "ok"), ""));
        assertFalse(PushReply.verify(KEY, text(200, "ok"), null));
        assertFalse(PushReply.verify(KEY, text(200, "ok"), "N_EQ8lI-R6A-2WZQJ0ZF2X1lAiTATwNpyCDI8oiEk8B"));
        // Подпись отказа не выдаётся за успех, подпись другой кнопки — за эту.
        assertFalse(PushReply.verify(KEY, text(200, "ok"), DECIDED_409));
        assertFalse(PushReply.verify(KEY, PushReply.text("ph_h", "android_1", "r1", "deny", "notification", 1_000_000L, 200, "ok"), OK_200));
        assertFalse(PushReply.verify("other".getBytes(StandardCharsets.UTF_8), text(200, "ok"), OK_200));
        assertFalse(PushReply.verify(new byte[0], text(200, "ok"), OK_200));
    }

    @Test
    public void showsAnOutcomeOnlyForASignedReply() {
        PushReply.Shown ok = PushReply.shown(ru, KEY, PREFIX, "allow", 200, "", "", "", OK_200);
        assertTrue(ok.verified);
        assertTrue(ok.done);
        assertEquals("Одобрено", ok.text);

        // Посредник ответил 200 без подписи или с подписью отказа — «не подтвердил», итога нет.
        for (String mac : new String[] {"", DECIDED_409}) {
            PushReply.Shown forged = PushReply.shown(ru, KEY, PREFIX, "allow", 200, "", "", "", mac);
            assertFalse(forged.verified);
            assertFalse(forged.done);
            assertEquals("Компьютер не подтвердил решение — откройте приложение", forged.text);
        }

        PushReply.Shown decided = PushReply.shown(ru, KEY, PREFIX, "allow", 409, "already_decided", "", "", DECIDED_409);
        assertTrue(decided.verified);
        assertEquals("Уже решено", decided.text);

        PushReply.Shown anna = PushReply.shown(ru, KEY, PREFIX, "allow", 409, "Owned by Анна", "team.hitlOfMember", "Анна", ANNA_409);
        assertEquals("Это запрос агента участника Анна — решает он сам или maintainer", anna.text);
        // Подменённое имя участника ломает подпись.
        assertFalse(PushReply.shown(ru, KEY, PREFIX, "allow", 409, "Owned by Анна", "team.hitlOfMember", "Мэллори", ANNA_409).verified);
        assertFalse(PushReply.shown(ru, KEY, PREFIX, "allow", 409, "Owned by Анна", "team.hitlOfOwner", "Анна", ANNA_409).verified);
    }

    @Test
    public void encodesBase64UrlWithoutPaddingLikeTheHost() throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest("x".getBytes(StandardCharsets.UTF_8));
        String[] host = {"", "LQ", "LXE", "LXEW", "LXEWQg", "LXEWQrc"};
        for (int n = 0; n < host.length; n++) assertEquals(host[n], PushReply.b64url(Arrays.copyOf(digest, n)));
        assertEquals("ok", PushReply.outcome(200, "ignored", "c", "m"));
        assertEquals("\n\n", PushReply.outcome(403, null, null, null));
    }
}
