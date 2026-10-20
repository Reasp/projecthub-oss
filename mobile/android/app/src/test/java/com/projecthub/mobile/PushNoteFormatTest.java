package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Уведомление о сообщении агента `projecthub_notify` (TASK-140.5, decision-117 п. 8). */
public class PushNoteFormatTest {
    @Test
    public void titleNamesComputerAndAgent() {
        PushNoteFormat f = PushNoteFormat.of("Work-A", "Codex", "Тесты прошли", "success", "shop");
        assertEquals("Work-A: Codex", f.title);
        assertEquals("Тесты прошли", f.text);
        assertEquals("готово · shop", f.subText);
        assertFalse(f.urgent);
    }

    @Test
    public void errorsAndWarningsAreUrgent() {
        assertTrue(PushNoteFormat.of("H", "", "x", "error", "").urgent);
        assertTrue(PushNoteFormat.of("H", "", "x", "warning", "").urgent);
        assertFalse(PushNoteFormat.of("H", "", "x", "info", "").urgent);
    }

    @Test
    public void emptyFieldsFallBack() {
        PushNoteFormat f = PushNoteFormat.of("", " ", "", "unknown", null);
        assertEquals("ProjectHub: Агент", f.title);
        assertEquals("Агент прислал сообщение", f.text);
        assertEquals("сообщение", f.subText);
    }
}
