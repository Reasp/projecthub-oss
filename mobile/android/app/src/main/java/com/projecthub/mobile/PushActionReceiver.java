package com.projecthub.mobile;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Кнопки «Одобрить» и «Отклонить» в уведомлении (TASK-140.3, decision-115). Решение подписывается ключом кнопок
 * этого ПК (HMAC-SHA256) и уходит на хост напрямую по его адресам из push: локальная сеть, VPN, туннель. Способ
 * подтверждения — `notification`, если экран заблокирован, иначе `unlocked`; хост сам сверяет его с классом риска.
 * Через релей кнопка не работает — тогда уведомление предлагает открыть приложение.
 */
public class PushActionReceiver extends BroadcastReceiver {
    static final String ACTION = "com.projecthub.mobile.PUSH_ACTION";
    private static final String LABEL = "projecthub-push-action-v1";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        final PendingResult pending = goAsync();
        final Context ctx = context.getApplicationContext();
        new Thread(() -> {
            try {
                handle(ctx, intent);
            } finally {
                pending.finish();
            }
        }).start();
    }

    private static void handle(Context ctx, Intent intent) {
        String instance = intent.getStringExtra(PushNotifier.EXTRA_INSTANCE);
        String host = intent.getStringExtra("host");
        int notifId = intent.getIntExtra("notifId", 0);
        String decision = "allow".equals(intent.getStringExtra("decision")) ? "allow" : "deny";
        PushRegistry.Reg reg = instance == null ? null : PushRegistry.get(ctx, instance);
        if (reg == null) {
            PushNotifier.showOutcome(ctx, instance, host, notifId, "Push для этого компьютера выключен — откройте приложение", false);
            return;
        }
        KeyguardManager keyguard = ctx.getSystemService(KeyguardManager.class);
        String confirm = keyguard != null && keyguard.isDeviceLocked() ? "notification" : "unlocked";
        long ts = System.currentTimeMillis();
        String did = intent.getStringExtra("did");
        String rid = intent.getStringExtra("rid");
        String hid = intent.getStringExtra("hid");
        String body;
        try {
            String signed = LABEL + "\n" + hid + "\n" + did + "\n" + rid + "\n" + decision + "\n" + confirm + "\n" + ts;
            JSONObject o = new JSONObject();
            o.put("deviceId", did);
            o.put("requestId", rid);
            o.put("decision", decision);
            o.put("confirm", confirm);
            o.put("ts", ts);
            o.put("mac", PushRegistry.b64(WebPush.actionMac(reg.actionKey, signed)));
            body = o.toString();
        } catch (Exception e) {
            PushNotifier.showOutcome(ctx, instance, host, notifId, "Не удалось подписать решение — откройте приложение", false);
            return;
        }

        String outcome = "Нет связи с компьютером — откройте приложение";
        boolean done = false;
        try {
            JSONArray endpoints = new JSONArray(intent.getStringExtra("ep") == null ? "[]" : intent.getStringExtra("ep"));
            for (int i = 0; i < endpoints.length() && !done; i++) {
                String base = endpoints.getJSONObject(i).optString("url");
                if (!base.startsWith("http://") && !base.startsWith("https://")) continue;
                int status;
                String reply;
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(base.replaceAll("/+$", "") + "/api/remote/push-action").openConnection();
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(5000);
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    conn.setInstanceFollowRedirects(false);
                    conn.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                    status = conn.getResponseCode();
                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    reply = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
                    conn.disconnect();
                } catch (Exception e) {
                    continue;
                }
                if (status == 200) {
                    outcome = "allow".equals(decision) ? "Одобрено" : "Отклонено";
                    done = true;
                } else if (status == 409) {
                    String reason = new JSONObject(reply.isEmpty() ? "{}" : reply).optString("reason");
                    outcome = "confirmation_required".equals(reason)
                        ? "Для такого риска нужно подтверждение в приложении"
                        : "already_decided".equals(reason) ? "Уже решено" : "Запрос не найден — возможно, истёк";
                    done = !"confirmation_required".equals(reason);
                    break;
                } else if (status == 403) {
                    outcome = "Компьютер не принял решение — откройте приложение";
                    break;
                }
            }
        } catch (Exception e) {
            // Повреждённый список адресов — остаётся «нет связи».
        }
        PushNotifier.showOutcome(ctx, instance, host, notifId, outcome, done);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[2048];
        int n;
        while ((n = in.read(chunk)) > 0 && buf.size() < 16384) buf.write(chunk, 0, n);
        in.close();
        return buf.toByteArray();
    }
}
