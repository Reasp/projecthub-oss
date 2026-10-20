package com.projecthub.mobile;

/**
 * Текст уведомления о сообщении агента `projecthub_notify` (TASK-140.5, decision-117 п. 8) — без Android, проверяется
 * JVM-тестом. Заголовок — компьютер и агент, текст — сообщение целиком, подпись — важность и проект.
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

    static String levelText(String level) {
        if ("error".equals(level)) return "ошибка";
        if ("warning".equals(level)) return "нужно внимание";
        if ("success".equals(level)) return "готово";
        return "сообщение";
    }

    private static boolean empty(String s) {
        return s == null || s.trim().isEmpty();
    }

    static PushNoteFormat of(String host, String agent, String text, String level, String project) {
        String who = empty(agent) ? "Агент" : agent.trim();
        String title = (empty(host) ? "ProjectHub" : host.trim()) + ": " + who;
        String sub = levelText(level) + (empty(project) ? "" : " · " + project.trim());
        boolean urgent = "error".equals(level) || "warning".equals(level);
        return new PushNoteFormat(title, empty(text) ? "Агент прислал сообщение" : text, sub, urgent);
    }
}
