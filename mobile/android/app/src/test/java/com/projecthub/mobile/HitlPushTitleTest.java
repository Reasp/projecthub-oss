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
    public void templateParamsFromHost() {
        java.util.Map<String, String> p = new java.util.HashMap<>();
        p.put("number", "12");
        p.put("title", "Fix login");
        assertEquals("Опубликовать ревью PR #12 «Fix login»", HitlPushTitle.of(ru, "pr_publish", "", "", p, "x"));
        assertEquals("Publish PR #12 review «Fix login»", HitlPushTitle.of(en, "pr_publish", "", "", p, "x"));
        assertEquals("Агент заводит задачу: Новая задача", HitlPushTitle.of(ru, "task_create", "Новая задача", "", p, "x"));
    }

    @Test
    public void unknownCodeOrOldHostKeepsHostTitle() {
        assertEquals("Bash: rm -rf dist", HitlPushTitle.of(ru, null, null, null, "Bash: rm -rf dist"));
        assertEquals("New kind", HitlPushTitle.of(ru, "future_code", "x", "A", "New kind"));
    }
}
