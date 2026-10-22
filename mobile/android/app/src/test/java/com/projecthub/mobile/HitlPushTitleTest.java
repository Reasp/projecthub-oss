package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.BeforeClass;
import org.junit.Test;

/** Заголовок запроса решения в push по коду хоста (TASK-205). */
public class HitlPushTitleTest {
    private static Texts ru;
    private static Texts en;

    @BeforeClass
    public static void load() throws Exception {
        ru = ResTexts.load("values-ru");
        en = ResTexts.load("values");
    }

    @Test
    public void titleFromCodeInPhoneLanguage() {
        assertEquals("Кодер: Запись файла: a.txt", HitlPushTitle.of(ru, "file_write", "a.txt", "Кодер", "Coder: Write file: a.txt"));
        assertEquals("Coder: Write file: a.txt", HitlPushTitle.of(en, "file_write", "a.txt", "Coder", "x"));
        assertEquals("Отменить слияние основной ветки", HitlPushTitle.of(ru, "sync_abort", "", "", "Abort merging the base branch"));
    }

    @Test
    public void unknownCodeOrOldHostKeepsHostTitle() {
        assertEquals("Bash: rm -rf dist", HitlPushTitle.of(ru, null, null, null, "Bash: rm -rf dist"));
        assertEquals("New kind", HitlPushTitle.of(ru, "future_code", "x", "A", "New kind"));
    }
}
