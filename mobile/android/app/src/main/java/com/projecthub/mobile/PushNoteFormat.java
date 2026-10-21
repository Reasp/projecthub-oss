package com.projecthub.mobile;

/**
 * Текст уведомления о сообщении агента `projecthub_notify` (TASK-140.5, decision-117 п. 8) — без Android, проверяется
 * JVM-тестом. Заголовок — компьютер и агент, текст — сообщение целиком, подпись — важность и проект. Строки — из
 * ресурсов через `Texts` (TASK-140.15).
 */
final class PushNoteFormat {
    final String title;
    final String text;
    final String subText;
    /** Ошибка и предупреждение — высокий приоритет уведомления (на Android 8+ важность задаёт канал «Сообщения агентов»). */
    final boolean urgent;

    private PushNoteFormat(String title, String text, String subText, boolean urgent) {
        this.title = title;
        this.text = text;
        this.subText = subText;
        this.urgent = urgent;
    }

    static int levelRes(String level) {
        if ("error".equals(level)) return R.string.note_level_error;
        if ("warning".equals(level)) return R.string.note_level_warning;
        if ("success".equals(level)) return R.string.note_level_success;
        return R.string.note_level_info;
    }

    private static boolean empty(String s) {
        return s == null || s.trim().isEmpty();
    }

    static PushNoteFormat of(Texts t, String host, String agent, String text, String level, String project) {
        String who = empty(agent) ? t.get(R.string.agent_default) : agent.trim();
        String title = (empty(host) ? "ProjectHub" : host.trim()) + ": " + who;
        String sub = t.get(levelRes(level)) + (empty(project) ? "" : " · " + project.trim());
        boolean urgent = "error".equals(level) || "warning".equals(level);
        return new PushNoteFormat(title, empty(text) ? t.get(R.string.note_default_text) : text, sub, urgent);
    }
}
