package com.projecthub.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Ход агента из push `t: "prog"` (TASK-140.7, decision-121) — без Android, проверяется JVM-тестом: тексты уведомления и
 * виджета, постоянное ли уведомление, процент, и список последних роёв для виджета.
 */
final class ProgressFormat {
    static final class Entry {
        final String instance;
        final String hostId;
        final String host;
        final String swarmId;
        final String title;
        final String state;
        final String step;
        /** 0–100; -1 — неопределённый прогресс. */
        final int percent;
        final long ts;

        Entry(String instance, String hostId, String host, String swarmId, String title, String state, String step, int percent, long ts) {
            this.instance = instance == null ? "" : instance;
            this.hostId = hostId == null ? "" : hostId;
            this.host = host == null || host.isEmpty() ? "ProjectHub" : host;
            this.swarmId = swarmId == null ? "" : swarmId;
            this.title = title == null || title.isEmpty() ? "Агент" : title;
            this.state = state == null ? "running" : state;
            this.step = step == null ? "" : step;
            this.percent = percent < 0 ? -1 : Math.min(100, percent);
            this.ts = ts;
        }

        String key() {
            return hostId + "\n" + swarmId;
        }
    }

    /** Постоянное уведомление — пока агент работает или ждёт решения. Итог можно смахнуть. */
    static boolean ongoing(String state) {
        return "running".equals(state) || "waiting".equals(state);
    }

    static String stateLabel(String state) {
        if ("waiting".equals(state)) return "ждёт решения";
        if ("done".equals(state)) return "готово";
        if ("failed".equals(state)) return "ошибка";
        if ("stopped".equals(state)) return "остановлен";
        return "работает";
    }

    static String title(Entry e) {
        return e.host + ": " + e.title;
    }

    static String text(Entry e) {
        return e.step.isEmpty() ? stateLabel(e.state) : e.step;
    }

    /** Строка виджета: состояние и фаза, без повтора, если фаза уже говорит то же («готово»). */
    static String widgetLine(Entry e) {
        String label = stateLabel(e.state);
        if (e.step.isEmpty() || e.step.startsWith(label)) return e.step.isEmpty() ? label : e.step;
        return label + " · " + e.step;
    }

    /** Короткий текст для чипа в строке состояния (Android 16): процент или состояние. */
    static String chip(Entry e) {
        if ("waiting".equals(e.state)) return "ждёт";
        if (e.percent >= 0 && ongoing(e.state)) return e.percent + "%";
        return stateLabel(e.state);
    }

    /** Итог агента живёт в виджете и уведомлении час. */
    static final long FINISHED_TTL_MS = 60L * 60 * 1000;

    /**
     * Список для виджета: запись роя заменяет прежнюю того же роя, завершённые старше часа убираются, сверху — сначала
     * работающие, затем свежие. Не больше `limit`.
     */
    static List<Entry> merge(List<Entry> current, Entry incoming, long now, int limit) {
        List<Entry> out = new ArrayList<>();
        for (Entry e : current) {
            if (e.key().equals(incoming.key())) continue;
            if (!ongoing(e.state) && now - e.ts > FINISHED_TTL_MS) continue;
            out.add(e);
        }
        out.add(incoming);
        Collections.sort(out, (a, b) -> {
            boolean oa = ongoing(a.state);
            boolean ob = ongoing(b.state);
            if (oa != ob) return oa ? -1 : 1;
            return Long.compare(b.ts, a.ts);
        });
        return out.size() > limit ? new ArrayList<>(out.subList(0, limit)) : out;
    }
}
