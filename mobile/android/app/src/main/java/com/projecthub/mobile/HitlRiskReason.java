package com.projecthub.mobile;

import android.content.Context;

/**
 * Причина класса риска запроса решения в push на языке телефона (TASK-202.11): хост присылает код wk и инструмент
 * wt кода unknownTool, текст берётся из ресурсов hitl_risk_* — те же тексты, что hitlRequestText.risks.
 * Неизвестный код или пакет старого хоста — запасной текст why.
 */
final class HitlRiskReason {
    private HitlRiskReason() {}

    static int codeRes(String code) {
        if (code == null) return 0;
        switch (code) {
            case "ciStatus": return R.string.hitl_risk_ciStatus;
            case "ciLog": return R.string.hitl_risk_ciLog;
            case "memorySearch": return R.string.hitl_risk_memorySearch;
            case "docsRead": return R.string.hitl_risk_docsRead;
            case "docsSearch": return R.string.hitl_risk_docsSearch;
            case "tasksRead": return R.string.hitl_risk_tasksRead;
            case "phoneInbox": return R.string.hitl_risk_phoneInbox;
            case "trackerPreview": return R.string.hitl_risk_trackerPreview;
            case "trackerStatus": return R.string.hitl_risk_trackerStatus;
            case "ciRerun": return R.string.hitl_risk_ciRerun;
            case "memoryWrite": return R.string.hitl_risk_memoryWrite;
            case "memoryDelete": return R.string.hitl_risk_memoryDelete;
            case "docCreate": return R.string.hitl_risk_docCreate;
            case "docUpdate": return R.string.hitl_risk_docUpdate;
            case "docBranchesRead": return R.string.hitl_risk_docBranchesRead;
            case "docBranchOwn": return R.string.hitl_risk_docBranchOwn;
            case "docBranchResolve": return R.string.hitl_risk_docBranchResolve;
            case "docBranchPropose": return R.string.hitl_risk_docBranchPropose;
            case "docBranchClose": return R.string.hitl_risk_docBranchClose;
            case "docBranchMerge": return R.string.hitl_risk_docBranchMerge;
            case "taskCreate": return R.string.hitl_risk_taskCreate;
            case "taskUpdate": return R.string.hitl_risk_taskUpdate;
            case "taskApprove": return R.string.hitl_risk_taskApprove;
            case "taskClaim": return R.string.hitl_risk_taskClaim;
            case "taskRelease": return R.string.hitl_risk_taskRelease;
            case "trackerWrite": return R.string.hitl_risk_trackerWrite;
            case "prComment": return R.string.hitl_risk_prComment;
            case "syncBaseBranch": return R.string.hitl_risk_syncBaseBranch;
            case "mergeSecurity": return R.string.hitl_risk_mergeSecurity;
            case "commitSecrets": return R.string.hitl_risk_commitSecrets;
            case "gitPush": return R.string.hitl_risk_gitPush;
            case "gitDestructive": return R.string.hitl_risk_gitDestructive;
            case "gitGlobalConfig": return R.string.hitl_risk_gitGlobalConfig;
            case "deleteFiles": return R.string.hitl_risk_deleteFiles;
            case "systemOperation": return R.string.hitl_risk_systemOperation;
            case "network": return R.string.hitl_risk_network;
            case "permissions": return R.string.hitl_risk_permissions;
            case "publishPackage": return R.string.hitl_risk_publishPackage;
            case "infrastructure": return R.string.hitl_risk_infrastructure;
            case "ghWrite": return R.string.hitl_risk_ghWrite;
            case "inlineCode": return R.string.hitl_risk_inlineCode;
            case "nestedShell": return R.string.hitl_risk_nestedShell;
            case "readEnv": return R.string.hitl_risk_readEnv;
            case "secretFile": return R.string.hitl_risk_secretFile;
            case "commandSubstitution": return R.string.hitl_risk_commandSubstitution;
            case "fileRedirect": return R.string.hitl_risk_fileRedirect;
            case "readOnly": return R.string.hitl_risk_readOnly;
            case "changesTree": return R.string.hitl_risk_changesTree;
            case "noCommand": return R.string.hitl_risk_noCommand;
            case "writeOutside": return R.string.hitl_risk_writeOutside;
            case "readOutside": return R.string.hitl_risk_readOutside;
            case "writeInProject": return R.string.hitl_risk_writeInProject;
            case "readInProject": return R.string.hitl_risk_readInProject;
            case "computer": return R.string.hitl_risk_computer;
            case "question": return R.string.hitl_risk_question;
            case "subagent": return R.string.hitl_risk_subagent;
            case "harmless": return R.string.hitl_risk_harmless;
            case "browserEscape": return R.string.hitl_risk_browserEscape;
            case "unknownTool": return R.string.hitl_risk_unknownTool;
            case "unknownAction": return R.string.hitl_risk_unknownAction;
            default: return 0;
        }
    }

    static String of(Context ctx, String code, String tool, String fallback) {
        int res = codeRes(code);
        if (res == 0) return fallback == null ? "" : fallback;
        return ctx.getString(res).replace("{tool}", tool == null ? "" : tool);
    }
}