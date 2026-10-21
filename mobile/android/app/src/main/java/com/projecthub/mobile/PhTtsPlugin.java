package com.projecthub.mobile;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Озвучка ответов голосового режима (TASK-179.2, decision-137 п. 8): системный TextToSpeech телефона. Синтез идёт на
 * телефоне — ответ звучит без задержки сети и без связи с ПК. `speak` завершается, когда фраза договорена или прервана.
 */
@CapacitorPlugin(name = "PhTts")
public class PhTtsPlugin extends Plugin {
    private TextToSpeech tts;
    /** Движок готов: 1 — да, -1 — недоступен, 0 — ещё инициализируется. */
    private volatile int ready = 0;
    private final AtomicLong seq = new AtomicLong();
    private final Map<String, PluginCall> pending = new ConcurrentHashMap<>();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            ready = status == TextToSpeech.SUCCESS ? 1 : -1;
            if (ready == 1) tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { finish(id, false); }
                @Override public void onError(String id) { finish(id, true); }
                @Override public void onStop(String id, boolean interrupted) { finish(id, false); }
            });
        });
    }

    private void finish(String id, boolean error) {
        PluginCall call = pending.remove(id);
        if (call == null) return;
        if (error) call.reject("tts_error");
        else call.resolve();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", ready >= 0);
        ret.put("ready", ready == 1);
        call.resolve(ret);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.resolve();
            return;
        }
        if (ready != 1) {
            call.reject(ready == 0 ? "tts_not_ready" : "tts_unavailable");
            return;
        }
        String lang = call.getString("lang", "ru");
        Locale locale = "en".equals(lang) ? Locale.US : new Locale("ru", "RU");
        int res = tts.setLanguage(locale);
        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
            call.reject("tts_language_missing");
            return;
        }
        String id = "u" + seq.incrementAndGet();
        call.setKeepAlive(false);
        pending.put(id, call);
        Bundle params = new Bundle();
        // Новая фраза прерывает прежнюю: голосовой режим не копит очередь ответов.
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) {
            pending.remove(id);
            call.reject("tts_error");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        for (String id : pending.keySet()) finish(id, false);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
    }
}
