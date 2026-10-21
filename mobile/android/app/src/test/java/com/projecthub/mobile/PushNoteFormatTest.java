package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.BeforeClass;
import org.junit.Test;

/** Уведомление о сообщении агента `projecthub_notify` (TASK-140.5, decision-117 п. 8); строки — TASK-140.15. */
public class PushNoteFormatTest {
    private static Texts ru;
    private static Texts en;

    @BeforeClass
    public static void load() throws Exception {
        ru = ResTexts.load("values-ru");
        en = ResTexts.load("values");
    }

    @Test
    public void titleNamesComputerAndAgent() {
        PushNoteFormat f = PushNoteFormat.of(ru, "Work-A", "Codex", "Тесты прошли", "success", "shop");
        assertEquals("Work-A: Codex", f.title);
        assertEquals("Тесты прошли", f.text);
        assertEquals("готово · shop", f.subText);
        assertFalse(f.urgent);
        assertEquals("done · shop", PushNoteFormat.of(en, "Work-A", "Codex", "Tests passed", "success", "shop").subText);
    }

    @Test
    public void errorsAndWarningsAreUrgent() {
        assertTrue(PushNoteFormat.of(ru, "H", "", "x", "error", "").urgent);
        assertTrue(PushNoteFormat.of(ru, "H", "", "x", "warning", "").urgent);
        assertFalse(PushNoteFormat.of(ru, "H", "", "x", "info", "").urgent);
    }

    @Test
    public void emptyFieldsFallBack() {
        PushNoteFormat f = PushNoteFormat.of(ru, "", " ", "", "unknown", null);
        assertEquals("ProjectHub: Агент", f.title);
        assertEquals("Агент прислал сообщение", f.text);
        assertEquals("сообщение", f.subText);
        PushNoteFormat e = PushNoteFormat.of(en, "", " ", "", "unknown", null);
        assertEquals("ProjectHub: Agent", e.title);
        assertEquals("The agent sent a message", e.text);
        assertEquals("message", e.subText);
    }
}
