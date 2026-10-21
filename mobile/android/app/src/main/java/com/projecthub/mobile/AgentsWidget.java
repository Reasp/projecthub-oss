package com.projecthub.mobile;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

/**
 * Виджет «Агенты» (TASK-140.7, decision-121 п. 3): до трёх последних роёв со всех ПК — компьютер, задача, фаза, полоса.
 * Данные — из push хода агента, их сохраняет `ProgressNotifier`. Нажатие открывает приложение.
 */
public class AgentsWidget extends AppWidgetProvider {
    private static final int[] ROWS = { R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3 };
    private static final int[] TITLES = { R.id.widget_title_1, R.id.widget_title_2, R.id.widget_title_3 };
    private static final int[] STEPS = { R.id.widget_step_1, R.id.widget_step_2, R.id.widget_step_3 };
    private static final int[] BARS = { R.id.widget_bar_1, R.id.widget_bar_2, R.id.widget_bar_3 };

    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        List<ProgressFormat.Entry> list = ProgressNotifier.load(ctx);
        Texts t = Texts.of(ctx);
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_agents);
            v.setViewVisibility(R.id.widget_empty, list.isEmpty() ? View.VISIBLE : View.GONE);
            for (int i = 0; i < ROWS.length; i++) {
                if (i >= list.size()) {
                    v.setViewVisibility(ROWS[i], View.GONE);
                    continue;
                }
                ProgressFormat.Entry e = list.get(i);
                v.setViewVisibility(ROWS[i], View.VISIBLE);
                v.setTextViewText(TITLES[i], ProgressFormat.title(t, e));
                v.setTextViewText(STEPS[i], ProgressFormat.widgetLine(t, e));
                boolean indeterminate = e.percent < 0 && ProgressFormat.ongoing(e.state);
                v.setProgressBar(BARS[i], 100, Math.max(0, e.percent), indeterminate);
                v.setOnClickPendingIntent(ROWS[i], PushNotifier.openIntent(ctx, e.instance, null, ("widget\n" + e.key()).hashCode()));
            }
            v.setOnClickPendingIntent(R.id.widget_root, PushNotifier.openIntent(ctx, "", null, ("widget\n" + id).hashCode()));
            manager.updateAppWidget(id, v);
        }
    }
}
