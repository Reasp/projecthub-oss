package com.projecthub.mobile;

import java.util.Collections;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Заголовок запроса решения в push на языке телефона (TASK-205, decision-161): хост присылает код `tk` (вид, цель,
 * агент, параметры шаблона — TASK-202.8), текст берётся из ресурсов. Неизвестный код или пакет старого хоста —
 * запасной `title` хоста. Шаблоны те же, что в `src/i18n/hitlRequestText.ts`. Без Android — проверяется JVM-тестом.
 */
final class HitlPushTitle {
    private HitlPushTitle() {}

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{(\\w+)\\}");

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
            case "read_excluded": return R.string.hitl_code_read_excluded;
            case "subagent": return R.string.hitl_code_subagent;
            case "tool": return R.string.hitl_code_tool;
            case "browser_host": return R.string.hitl_code_browser_host;
            case "assistant_question": return R.string.hitl_code_assistant_question;
            case "merge_security": return R.string.hitl_code_merge_security;
            case "merge_security_many": return R.string.hitl_code_merge_security_many;
            case "merge_renumber": return R.string.hitl_code_merge_renumber;
            case "plan_conflict": return R.string.hitl_code_plan_conflict;
            case "plan_renumber": return R.string.hitl_code_plan_renumber;
            case "ci_rerun": return R.string.hitl_code_ci_rerun;
            case "ci_play": return R.string.hitl_code_ci_play;
            case "task_create": return R.string.hitl_code_task_create;
            case "tracker_sync": return R.string.hitl_code_tracker_sync;
            case "doc_merge": return R.string.hitl_code_doc_merge;
            case "task_claim": return R.string.hitl_code_task_claim;
            case "task_release": return R.string.hitl_code_task_release;
            case "pr_publish": return R.string.hitl_code_pr_publish;
            case "computer_action": return R.string.hitl_code_computer_action;
            case "computer_dangerous": return R.string.hitl_code_computer_dangerous;
            default: return 0;
        }
    }

    private static boolean empty(String s) {
        return s == null || s.trim().isEmpty();
    }

    /** Подстановка {name}: параметр кода или цель; неизвестный остаётся как есть. */
    static String fill(String template, String target, Map<String, String> params) {
        Matcher m = PLACEHOLDER.matcher(template);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String name = m.group(1);
            String value = "target".equals(name) ? (target == null ? "" : target.trim()) : params.get(name);
            m.appendReplacement(out, Matcher.quoteReplacement(value == null ? m.group(0) : value));
        }
        m.appendTail(out);
        return out.toString();
    }

    static String of(Texts t, String code, String target, String agent, String fallback) {
        return of(t, code, target, agent, Collections.emptyMap(), fallback);
    }

    static String of(Texts t, String code, String target, String agent, Map<String, String> params, String fallback) {
        int res = codeRes(code);
        if (res == 0) return fallback == null ? "" : fallback;
        String template = t.get(res);
        String suffix = empty(target) || template.contains("{target}") ? "" : ": " + target.trim();
        return (empty(agent) ? "" : agent.trim() + ": ") + fill(template, target, params == null ? Collections.emptyMap() : params) + suffix;
    }
}
