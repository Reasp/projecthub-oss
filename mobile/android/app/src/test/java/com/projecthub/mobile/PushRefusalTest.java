package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.BeforeClass;
import org.junit.Test;

/** Итог кнопки уведомления при отказе хоста `409` (TASK-216). */
public class PushRefusalTest {
    private static Texts ru;
    private static Texts en;

    @BeforeClass
    public static void load() throws Exception {
        ru = ResTexts.load("values-ru");
        en = ResTexts.load("values");
    }

    @Test
    public void notOwnerByCodeInPhoneLanguage() {
        String hostText = "This is a request from the agent of member Anna: it is decided by them or a member with the maintainer role";
        assertEquals("Это запрос агента участника Anna — решает он сам или maintainer",
            PushRefusal.text(ru, hostText, "team.hitlOfMember", "Anna"));
        assertEquals("This request is from the agent of Anna — they or a maintainer decide it",
            PushRefusal.text(en, hostText, "team.hitlOfMember", "Anna"));
        assertEquals("Это запрос агента владельца хоста — решает он сам или maintainer",
            PushRefusal.text(ru, "x", "team.hitlOfOwner", null));
    }

    @Test
    public void notOwnerWithoutKnownCodeIsNotNotFound() {
        // Хост до decision-165 присылал в reason только текст причины.
        assertEquals("Это запрос агента другого участника — решает он сам или maintainer",
            PushRefusal.text(ru, "Это запрос агента участника Анна: решает он сам", null, null));
        assertEquals("Это запрос агента другого участника — решает он сам или maintainer",
            PushRefusal.text(ru, "x", "team.hitlOfMember", " "));
        assertEquals("Это запрос агента другого участника — решает он сам или maintainer",
            PushRefusal.text(ru, "x", "edition.ownershipCheckFailed", null));
    }

    @Test
    public void knownReasonCodes() {
        assertEquals("Уже решено", PushRefusal.text(ru, "already_decided", null, null));
        assertEquals("Запрос не найден — возможно, истёк", PushRefusal.text(ru, "not_found", null, null));
        assertEquals("Запрос не найден — возможно, истёк", PushRefusal.text(ru, "invalid_source", null, null));
        assertEquals("Запрос не найден — возможно, истёк", PushRefusal.text(ru, "", null, null));
        assertEquals("This risk level needs confirmation in the app", PushRefusal.text(en, "confirmation_required", null, null));
        assertFalse(PushRefusal.isFinal("confirmation_required"));
        assertTrue(PushRefusal.isFinal("team.hitlOfMember"));
    }
}
