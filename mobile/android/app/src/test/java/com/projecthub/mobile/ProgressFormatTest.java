package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.BeforeClass;
import org.junit.Test;

/** Ход агента на экране блокировки и в виджете (TASK-140.7, decision-121); строки — TASK-140.15. */
public class ProgressFormatTest {
    private static Texts ru;
    private static Texts en;

    @BeforeClass
    public static void load() throws Exception {
        ru = ResTexts.load("values-ru");
        en = ResTexts.load("values");
    }

    private static ProgressFormat.Entry e(String host, String sid, String state, int pct, long ts) {
        return new ProgressFormat.Entry("p1", "h-" + host, host, sid, "TASK-7 · Экран", state, "итерация 2 из 5 — проверки", pct, ts);
    }

    @Test
    public void ongoingOnlyWhileRunningOrWaiting() {
        assertTrue(ProgressFormat.ongoing("running"));
        assertTrue(ProgressFormat.ongoing("waiting"));
        assertFalse(ProgressFormat.ongoing("done"));
        assertFalse(ProgressFormat.ongoing("failed"));
    }

    @Test
    public void texts() {
        ProgressFormat.Entry x = e("Work-A", "s1", "running", 30, 1);
        assertEquals("Work-A: TASK-7 · Экран", ProgressFormat.title(ru, x));
        assertEquals("итерация 2 из 5 — проверки", ProgressFormat.text(ru, x));
        assertEquals("30%", ProgressFormat.chip(ru, x));
        assertEquals("ждёт", ProgressFormat.chip(ru, e("A", "s", "waiting", 30, 1)));
        assertEquals("готово", ProgressFormat.chip(ru, e("A", "s", "done", 100, 1)));
        assertEquals(-1, new ProgressFormat.Entry("", "", "", "", "", "running", "", -5, 0).percent);
        ProgressFormat.Entry empty = new ProgressFormat.Entry(null, null, null, null, null, null, null, 0, 0);
        assertEquals("ProjectHub: Агент", ProgressFormat.title(ru, empty));
        assertEquals("ProjectHub: Agent", ProgressFormat.title(en, empty));
        assertEquals("waiting", ProgressFormat.chip(en, e("A", "s", "waiting", 30, 1)));
        assertEquals("stopped", ProgressFormat.text(en, new ProgressFormat.Entry("", "", "A", "s", "t", "stopped", "", -1, 0)));
    }

    @Test
    public void widgetLineHasNoRepeatedState() {
        assertEquals("готово", ProgressFormat.widgetLine(ru, new ProgressFormat.Entry("", "", "A", "s", "t", "done", "готово", 100, 0)));
        assertEquals("готово за 2 из 4", ProgressFormat.widgetLine(ru, new ProgressFormat.Entry("", "", "A", "s", "t", "done", "готово за 2 из 4", 100, 0)));
        assertEquals("работает · итерация 2 из 5 — проверки", ProgressFormat.widgetLine(ru, e("A", "s", "running", 30, 0)));
        assertEquals("ждёт решения", ProgressFormat.widgetLine(ru, new ProgressFormat.Entry("", "", "A", "s", "t", "waiting", "", -1, 0)));
        assertEquals("waiting for a decision", ProgressFormat.widgetLine(en, new ProgressFormat.Entry("", "", "A", "s", "t", "waiting", "", -1, 0)));
    }

    @Test
    public void mergeReplacesSameSwarmPrunesOldFinishedAndKeepsRunningFirst() {
        long now = 10L * 60 * 60 * 1000;
        List<ProgressFormat.Entry> list = new ArrayList<>(Arrays.asList(
            e("A", "old-done", "done", 100, now - ProgressFormat.FINISHED_TTL_MS - 1),
            e("A", "fresh-done", "done", 100, now - 1000),
            e("B", "s1", "running", 10, now - 5000)));
        List<ProgressFormat.Entry> out = ProgressFormat.merge(list, e("B", "s1", "waiting", 20, now), now, 3);
        assertEquals(2, out.size());
        assertEquals("s1", out.get(0).swarmId);
        assertEquals("waiting", out.get(0).state);
        assertEquals("fresh-done", out.get(1).swarmId);
        List<ProgressFormat.Entry> capped = ProgressFormat.merge(out, e("C", "s9", "running", 1, now), now, 2);
        assertEquals(2, capped.size());
    }
}
