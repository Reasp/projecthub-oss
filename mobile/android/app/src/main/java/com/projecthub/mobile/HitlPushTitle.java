package com.projecthub.mobile;

/**
 * Заголовок запроса решения в push на языке телефона (TASK-205, decision-161): хост присылает код `tk` (вид, цель,
 * агент), текст берётся из ресурсов. Неизвестный код или пакет старого хоста — запасной `title` хоста. Без Android —
 * проверяется JVM-тестом.
 */
final class HitlPushTitle {
    private HitlPushTitle() {}

    static int codeRes(String code) {
        if (code == null) return 0;
        switch (code) {
            case "file_write": return R.string.hitl_code_file_write;
            case "file_write_excluded": return R.string.hitl_code_file_write_excluded;
            case "command": return R.string.hitl_code_command;
            case "command_denied": return R.string.hitl_code_command_denied;
            case "process": return R.string.hitl_code_process;
            case "sync_merge": return R.string.hitl_code_sync_merge;
            case "sync_continue": return R.string.hitl_code_sync_continue;
            case "sync_abort": return R.string.hitl_code_sync_abort;
            case "read": return R.string.hitl_code_read;
            case "read_outside": return R.string.hitl_code_read_outside;
            case "question": return R.string.hitl_code_question;
            default: return 0;
        }
    }

    private static boolean empty(String s) {
        return s == null || s.trim().isEmpty();
    }

    static String of(Texts t, String code, String target, String agent, String fallback) {
        int res = codeRes(code);
        if (res == 0) return fallback == null ? "" : fallback;
        return (empty(agent) ? "" : agent.trim() + ": ") + t.get(res) + (empty(target) ? "" : ": " + target.trim());
    }
}
