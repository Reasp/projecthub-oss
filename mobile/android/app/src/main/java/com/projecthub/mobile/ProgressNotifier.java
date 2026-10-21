package com.projecthub.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Ход агента на экране блокировки (TASK-140.7, decision-121 п. 2–3): постоянное тихое уведомление в канале «Ход агентов»
 * с `ProgressStyle` и запросом продвижения (Live Update Android 16), последние рои — в `SharedPreferences` для виджета.
 */
final class ProgressNotifier {
    // Важность канала по умолчанию, а звук выключен у самого уведомления: канал с низкой важностью Android считает
    // «беззвучным» и прячет с экрана блокировки — а ход агента нужен именно там.
    static final String CHANNEL = "ph_agent_progress";
    static final String TAG = "ph_progress";
    private static final String PREFS = "ph_progress";
    private static final String KEY = "entries";
    static final int WIDGET_ROWS = 3;

    private ProgressNotifier() {}

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        // Канал создаётся и при каждом показе: у существующего система обновит только название и описание — так они
        // следуют за языком телефона, а звук и вибрация остаются как при создании.
        NotificationChannel ch = new NotificationChannel(CHANNEL, ctx.getString(R.string.channel_progress_name), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(ctx.getString(R.string.channel_progress_description));
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    static ProgressFormat.Entry entryOf(PushRegistry.Reg reg, JSONObject p) {
        return new ProgressFormat.Entry(reg.instance, p.optString("hid"), p.optString("host", reg.label), p.optString("sid"), p.optString("title"),
            p.optString("st", "running"), p.optString("step"), p.has("pct") ? p.optInt("pct", -1) : -1, p.optLong("ts", System.currentTimeMillis()));
    }

    static void show(Context ctx, PushRegistry.Reg reg, JSONObject p) {
        ProgressFormat.Entry e = entryOf(reg, p);
        Texts t = Texts.of(ctx);
        ensureChannel(ctx);
        int id = ("prog\n" + e.key()).hashCode();
        boolean ongoing = ProgressFormat.ongoing(e.state);
        NotificationCompat.ProgressStyle style = new NotificationCompat.ProgressStyle();
        if (e.percent >= 0) style.setProgress(e.percent);
        else style.setProgressIndeterminate(ongoing);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_projecthub)
            .setContentTitle(ProgressFormat.title(t, e))
            .setContentText(ProgressFormat.text(t, e))
            .setSubText(ProgressFormat.stateLabel(t, e.state))
            .setStyle(style)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShortCriticalText(ProgressFormat.chip(t, e))
            .setRequestPromotedOngoing(ongoing)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(PushNotifier.openIntent(ctx, reg.instance, null, id))
            .setWhen(e.ts)
            .setShowWhen(true);
        if (!ongoing) b.setAutoCancel(true).setTimeoutAfter(ProgressFormat.FINISHED_TTL_MS);
        if ("waiting".equals(e.state)) {
            b.addAction(new NotificationCompat.Action.Builder(0, ctx.getString(R.string.action_decide), PushNotifier.openIntent(ctx, reg.instance, null, id)).build());
        }
        try {
            NotificationManagerCompat.from(ctx).notify(TAG, id, b.build());
        } catch (SecurityException ignored) {
            // разрешение на уведомления отозвано
        }
        remember(ctx, e);
    }

    static List<ProgressFormat.Entry> load(Context ctx) {
        List<ProgressFormat.Entry> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(ctx).getString(KEY, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                out.add(new ProgressFormat.Entry(o.optString("i"), o.optString("hid"), o.optString("host"), o.optString("sid"), o.optString("title"),
                    o.optString("st"), o.optString("step"), o.optInt("pct", -1), o.optLong("ts")));
            }
        } catch (Exception ignored) {
            // испорченная запись — начинаем с пустого списка
        }
        return out;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void remember(Context ctx, ProgressFormat.Entry e) {
        List<ProgressFormat.Entry> list = ProgressFormat.merge(load(ctx), e, System.currentTimeMillis(), WIDGET_ROWS * 2);
        JSONArray arr = new JSONArray();
        try {
            for (ProgressFormat.Entry x : list) {
                arr.put(new JSONObject().put("i", x.instance).put("hid", x.hostId).put("host", x.host).put("sid", x.swarmId).put("title", x.title)
                    .put("st", x.state).put("step", x.step).put("pct", x.percent).put("ts", x.ts));
            }
        } catch (Exception ignored) {
            return;
        }
        prefs(ctx).edit().putString(KEY, arr.toString()).apply();
        Intent update = new Intent(ctx, AgentsWidget.class).setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        int[] ids = AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, AgentsWidget.class));
        if (ids.length == 0) return;
        update.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        ctx.sendBroadcast(update);
    }
}
