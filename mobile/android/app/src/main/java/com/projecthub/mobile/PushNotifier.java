package com.projecthub.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * Уведомление о запросе агента из расшифрованного push (TASK-140.3, decision-115). Кнопки — по классу риска
 * (decision-112 п. 3): `low` одобряется с заблокированного экрана, `moderate` — только после разблокировки, `high` —
 * только в приложении с биометрией. «Отклонить» есть всегда. Нажатие открывает приложение на этом ПК.
 */
final class PushNotifier {
    static final String CHANNEL = "ph_hitl";
    static final String TAG = "ph_hitl";
    static final String EXTRA_INSTANCE = "ph_instance";
    static final String EXTRA_REQUEST = "ph_request";
    static final String ACTION_OPEN = "com.projecthub.mobile.OPEN_HOST";

    private PushNotifier() {}

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        // У существующего канала система обновит только название и описание — они следуют за языком телефона.
        NotificationChannel ch = new NotificationChannel(CHANNEL, ctx.getString(R.string.channel_requests_name), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(ctx.getString(R.string.channel_requests_description));
        nm.createNotificationChannel(ch);
    }

    static int notificationId(String hostId, String requestId) {
        return (hostId + "\n" + requestId).hashCode();
    }

    static PendingIntent openIntent(Context ctx, String instance, String requestId, int code) {
        Intent open = new Intent(ctx, MainActivity.class)
            .setAction(ACTION_OPEN)
            .putExtra(EXTRA_INSTANCE, instance)
            .putExtra(EXTRA_REQUEST, requestId == null ? "" : requestId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent actionIntent(Context ctx, PushRegistry.Reg reg, JSONObject p, String decision, int notifId) {
        Intent intent = new Intent(ctx, PushActionReceiver.class)
            .setAction(PushActionReceiver.ACTION)
            // Уникальные данные — чтобы PendingIntent разных кнопок и запросов не сливались.
            .setData(Uri.parse("projecthub-push://" + notifId + "/" + decision))
            .putExtra(EXTRA_INSTANCE, reg.instance)
            .putExtra("hid", p.optString("hid"))
            .putExtra("host", p.optString("host"))
            .putExtra("did", p.optString("did"))
            .putExtra("rid", p.optString("rid"))
            .putExtra("risk", p.optString("risk"))
            .putExtra("title", p.optString("title"))
            .putExtra("decision", decision)
            .putExtra("ep", p.optJSONArray("ep") == null ? "[]" : p.optJSONArray("ep").toString())
            .putExtra("notifId", notifId);
        return PendingIntent.getBroadcast(ctx, notifId * 2 + ("allow".equals(decision) ? 1 : 0), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String riskText(Context ctx, String risk) {
        if ("low".equals(risk)) return ctx.getString(R.string.risk_low);
        if ("moderate".equals(risk)) return ctx.getString(R.string.risk_moderate);
        return ctx.getString(R.string.risk_high);
    }

    private static NotificationCompat.Builder base(Context ctx) {
        ensureChannel(ctx);
        return new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_projecthub)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true);
    }

    private static void post(Context ctx, int id, NotificationCompat.Builder b) {
        try {
            NotificationManagerCompat.from(ctx).notify(TAG, id, b.build());
        } catch (SecurityException e) {
            // Разрешение на уведомления отозвано — показать нечего.
        }
    }

    /** Push не расшифровался: только нейтральный текст, содержимое не угадываем. */
    static void showNeutral(Context ctx, PushRegistry.Reg reg) {
        int id = ("neutral\n" + reg.instance).hashCode();
        post(ctx, id, base(ctx).setContentTitle(reg.label == null || reg.label.isEmpty() ? "ProjectHub" : reg.label).setContentText(ctx.getString(R.string.hitl_neutral_text)).setContentIntent(openIntent(ctx, reg.instance, null, id)));
    }

    static void show(Context ctx, PushRegistry.Reg reg, byte[] plaintext) throws Exception {
        JSONObject p = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
        String type = p.optString("t");
        String host = p.optString("host", reg.label);
        if ("hitl_done".equals(type)) {
            NotificationManagerCompat.from(ctx).cancel(TAG, notificationId(p.optString("hid"), p.optString("rid")));
            return;
        }
        if ("test".equals(type)) {
            int id = ("test\n" + reg.instance).hashCode();
            post(ctx, id, base(ctx).setContentTitle(host).setContentText(ctx.getString(R.string.push_test_text)).setContentIntent(openIntent(ctx, reg.instance, null, id)));
            return;
        }
        if ("note".equals(type)) {
            showNote(ctx, reg, p, host);
            return;
        }
        if ("prog".equals(type)) {
            ProgressNotifier.show(ctx, reg, p);
            return;
        }
        if (!"hitl".equals(type)) return;

        String hid = p.optString("hid");
        String rid = p.optString("rid");
        String risk = p.optString("risk", "high");
        int id = notificationId(hid, rid);
        // Заголовок по коду — на языке телефона (TASK-205); без кода — текст хоста.
        JSONObject tk = p.optJSONObject("tk");
        String title = tk == null
            ? p.optString("title")
            : HitlPushTitle.of(Texts.of(ctx), tk.optString("c"), tk.optString("t"), tk.optString("a"), p.optString("title"));
        String what = p.optString("cmd", "").isEmpty() ? title : "$ " + p.optString("cmd");
        StringBuilder big = new StringBuilder(title);
        if (!p.optString("cmd", "").isEmpty()) big.append("\n$ ").append(p.optString("cmd"));
        else if (!p.optString("file", "").isEmpty()) big.append("\n").append(p.optString("file"));
        String why = p.optString("why", "");
        big.append("\n").append(riskText(ctx, risk)).append(why.isEmpty() ? "" : " — " + why);
        String who = p.optString("agent", "");
        String proj = p.optString("proj", "");

        NotificationCompat.Builder b = base(ctx)
            .setContentTitle(ctx.getString(R.string.hitl_title, host))
            .setContentText(what)
            .setSubText(riskText(ctx, risk) + (proj.isEmpty() ? "" : " · " + proj) + (who.isEmpty() ? "" : " · " + who))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(big.toString()))
            .setContentIntent(openIntent(ctx, reg.instance, rid, id))
            .setWhen(p.optLong("ts", System.currentTimeMillis()))
            .setShowWhen(true);

        if (p.optBoolean("dec", false)) {
            b.addAction(new NotificationCompat.Action.Builder(0, ctx.getString(R.string.action_deny), actionIntent(ctx, reg, p, "deny", id)).build());
            if ("low".equals(risk)) {
                b.addAction(new NotificationCompat.Action.Builder(0, ctx.getString(R.string.action_approve), actionIntent(ctx, reg, p, "allow", id)).build());
            } else if ("moderate".equals(risk) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Средний риск — только после разблокировки: система спросит PIN или отпечаток до нажатия.
                b.addAction(new NotificationCompat.Action.Builder(0, ctx.getString(R.string.action_approve), actionIntent(ctx, reg, p, "allow", id)).setAuthenticationRequired(true).build());
            } else {
                // Высокий риск (и средний на Android до 12) — в приложении, где видно всё и спрашивается биометрия.
                b.addAction(new NotificationCompat.Action.Builder(0, ctx.getString(R.string.action_review), openIntent(ctx, reg.instance, rid, id)).build());
            }
        }
        post(ctx, id, b);
    }

    /**
     * Сообщение агента `projecthub_notify` (TASK-140.5, decision-117 п. 8): отдельный канал «Сообщения агентов», чтобы
     * его можно было приглушить, не теряя запросы решений. Нажатие открывает «Входящие» этого ПК.
     */
    private static void showNote(Context ctx, PushRegistry.Reg reg, JSONObject p, String host) {
        ensureNoteChannel(ctx);
        PushNoteFormat f = PushNoteFormat.of(Texts.of(ctx), host, p.optString("agent", ""), p.optString("text", ""), p.optString("lvl", "info"), p.optString("proj", ""));
        int id = ("note\n" + p.optString("hid") + "\n" + p.optString("nid")).hashCode();
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, NOTE_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_projecthub)
            .setPriority(f.urgent ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentTitle(f.title)
            .setContentText(f.text)
            .setSubText(f.subText)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(f.text))
            .setContentIntent(openIntent(ctx, reg.instance, null, id))
            .setWhen(p.optLong("ts", System.currentTimeMillis()))
            .setShowWhen(true);
        post(ctx, id, b);
    }

    static final String NOTE_CHANNEL = "ph_note";

    static void ensureNoteChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(NOTE_CHANNEL, ctx.getString(R.string.channel_notes_name), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(ctx.getString(R.string.channel_notes_description));
        nm.createNotificationChannel(ch);
    }

    /** Итог нажатия кнопки — заменяет уведомление и само исчезает. */
    static void showOutcome(Context ctx, String instance, String host, int id, String text, boolean done) {
        NotificationCompat.Builder b = base(ctx).setContentTitle(host).setContentText(text).setContentIntent(openIntent(ctx, instance, null, id)).setOnlyAlertOnce(true);
        if (done) b.setTimeoutAfter(5000);
        post(ctx, id, b);
    }
}
