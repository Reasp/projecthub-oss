package com.projecthub.mobile;

import android.app.BroadcastOptions;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Клиент UnifiedPush без сторонней библиотеки (TASK-140.3, decision-115): широковещательные намерения спецификации
 * (AND_2 и AND_3) к дистрибьютору — ntfy или другому, без сервисов Google. Регистрация своя у каждого ПК: токен
 * соединения — `PushRegistry.Reg.token`, адрес приходит в NEW_ENDPOINT.
 */
final class UnifiedPush {
    static final String REGISTER = "org.unifiedpush.android.distributor.REGISTER";
    static final String UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER";
    static final String MESSAGE_ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK";
    static final String NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT";
    static final String REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED";
    static final String MESSAGE = "org.unifiedpush.android.connector.MESSAGE";
    static final String UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED";

    interface EndpointListener {
        void onEndpoint(String endpoint);

        void onFailed(String reason);
    }

    /** Ожидающие NEW_ENDPOINT регистрации: токен → слушатель. */
    private static final Map<String, EndpointListener> waiting = new HashMap<>();

    private UnifiedPush() {}

    /** Пакеты дистрибьюторов, которые принимают REGISTER (нужен <queries> в манифесте). */
    static List<String> distributors(Context ctx) {
        List<String> out = new ArrayList<>();
        PackageManager pm = ctx.getPackageManager();
        List<ResolveInfo> found = pm.queryBroadcastReceivers(new Intent(REGISTER), 0);
        for (ResolveInfo info : found) {
            String pkg = info.activityInfo != null ? info.activityInfo.packageName : null;
            if (pkg != null && !pkg.equals(ctx.getPackageName()) && !out.contains(pkg)) out.add(pkg);
        }
        return out;
    }

    private static void send(Context ctx, Intent intent) {
        if (Build.VERSION.SDK_INT >= 34) {
            // AND_3: дистрибьютор узнаёт приложение по общей идентичности отправителя.
            BroadcastOptions options = BroadcastOptions.makeBasic();
            options.setShareIdentityEnabled(true);
            ctx.sendBroadcast(intent, null, options.toBundle());
        } else {
            ctx.sendBroadcast(intent);
        }
    }

    private static PendingIntent identity(Context ctx) {
        // AND_3 до Android 14: неизменяемый PendingIntent раскрывает дистрибьютору имя пакета.
        return PendingIntent.getBroadcast(ctx, 0, new Intent("org.unifiedpush.dummy_app").setPackage(ctx.getPackageName()), PendingIntent.FLAG_IMMUTABLE);
    }

    static void register(Context ctx, PushRegistry.Reg reg, String message, EndpointListener listener) {
        synchronized (waiting) {
            waiting.put(reg.token, listener);
        }
        Intent intent = new Intent(REGISTER).setPackage(reg.distributor);
        intent.putExtra("token", reg.token);
        intent.putExtra("application", ctx.getPackageName()); // AND_2
        intent.putExtra("message", message);
        intent.putExtra("pi", identity(ctx));
        send(ctx, intent);
    }

    static void unregister(Context ctx, PushRegistry.Reg reg) {
        Intent intent = new Intent(UNREGISTER).setPackage(reg.distributor);
        intent.putExtra("token", reg.token);
        intent.putExtra("application", ctx.getPackageName());
        intent.putExtra("pi", identity(ctx));
        send(ctx, intent);
    }

    /** Токен, которого телефон не знает: UNREGISTER всем дистрибьюторам, чьим бы он ни был. */
    static void unregisterUnknown(Context ctx, String token) {
        if (token == null || token.isEmpty()) return;
        for (String pkg : distributors(ctx)) {
            Intent intent = new Intent(UNREGISTER).setPackage(pkg);
            intent.putExtra("token", token);
            intent.putExtra("application", ctx.getPackageName());
            intent.putExtra("pi", identity(ctx));
            send(ctx, intent);
        }
    }

    static void ack(Context ctx, PushRegistry.Reg reg, String id) {
        if (id == null || id.isEmpty()) return;
        Intent intent = new Intent(MESSAGE_ACK).setPackage(reg.distributor);
        intent.putExtra("token", reg.token);
        intent.putExtra("id", id);
        intent.putExtra("pi", identity(ctx));
        send(ctx, intent);
    }

    static EndpointListener takeListener(String token) {
        synchronized (waiting) {
            return waiting.remove(token);
        }
    }

    static void cancelWait(String token) {
        synchronized (waiting) {
            waiting.remove(token);
        }
    }
}
