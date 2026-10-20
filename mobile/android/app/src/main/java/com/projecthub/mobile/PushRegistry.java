package com.projecthub.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Регистрации push на телефоне (TASK-140.3, decision-115): одна на каждый ПК (профиль хоста), со своими ключами
 * RFC 8291 и ключом кнопок. Записи зашифрованы ключом Keystore (SecureBox), в хранилище WebView их нет.
 */
final class PushRegistry {
    private static final String PREFS = "ph_push";
    private static final String PREFIX = "reg:";

    static final class Reg {
        String instance;
        String label;
        /** Токен соединения UnifiedPush (AND_3: до 100 байт, UUID). */
        String token;
        String distributor;
        String endpoint;
        byte[] publicPoint;
        byte[] privatePkcs8;
        byte[] auth;
        byte[] actionKey;

        JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("instance", instance);
            o.put("label", label);
            o.put("token", token);
            o.put("distributor", distributor);
            o.put("endpoint", endpoint == null ? "" : endpoint);
            o.put("pub", b64(publicPoint));
            o.put("priv", b64(privatePkcs8));
            o.put("auth", b64(auth));
            o.put("actionKey", b64(actionKey));
            return o;
        }

        static Reg fromJson(JSONObject o) {
            Reg r = new Reg();
            r.instance = o.optString("instance");
            r.label = o.optString("label");
            r.token = o.optString("token");
            r.distributor = o.optString("distributor");
            r.endpoint = o.optString("endpoint");
            r.publicPoint = unb64(o.optString("pub"));
            r.privatePkcs8 = unb64(o.optString("priv"));
            r.auth = unb64(o.optString("auth"));
            r.actionKey = unb64(o.optString("actionKey"));
            return r;
        }
    }

    static String b64(byte[] v) {
        return Base64.encodeToString(v, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static byte[] unb64(String v) {
        return v == null || v.isEmpty() ? new byte[0] : Base64.decode(v, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Новые ключи для ПК; токен соединения сохраняется, если регистрация уже была. */
    static Reg create(Context ctx, String instance, String label, String distributor) throws Exception {
        Reg prev = get(ctx, instance);
        KeyPair pair = WebPush.generateKeyPair();
        SecureRandom random = new SecureRandom();
        Reg r = new Reg();
        r.instance = instance;
        r.label = label;
        r.token = prev != null && prev.token != null && !prev.token.isEmpty() ? prev.token : UUID.randomUUID().toString();
        r.distributor = distributor;
        r.endpoint = "";
        r.publicPoint = WebPush.uncompressed(pair.getPublic());
        r.privatePkcs8 = pair.getPrivate().getEncoded();
        r.auth = new byte[16];
        random.nextBytes(r.auth);
        r.actionKey = new byte[32];
        random.nextBytes(r.actionKey);
        save(ctx, r);
        return r;
    }

    static void save(Context ctx, Reg r) throws Exception {
        prefs(ctx).edit().putString(PREFIX + r.instance, SecureBox.seal(r.toJson().toString().getBytes(StandardCharsets.UTF_8))).apply();
    }

    static Reg get(Context ctx, String instance) {
        String stored = prefs(ctx).getString(PREFIX + instance, null);
        if (stored == null) return null;
        try {
            return Reg.fromJson(new JSONObject(new String(SecureBox.open(stored), StandardCharsets.UTF_8)));
        } catch (Exception e) {
            prefs(ctx).edit().remove(PREFIX + instance).apply();
            return null;
        }
    }

    static List<Reg> all(Context ctx) {
        List<Reg> out = new ArrayList<>();
        for (Map.Entry<String, ?> e : prefs(ctx).getAll().entrySet()) {
            if (!e.getKey().startsWith(PREFIX)) continue;
            Reg r = get(ctx, e.getKey().substring(PREFIX.length()));
            if (r != null) out.add(r);
        }
        return out;
    }

    static Reg byToken(Context ctx, String token) {
        if (token == null) return null;
        for (Reg r : all(ctx)) if (token.equals(r.token)) return r;
        return null;
    }

    static void remove(Context ctx, String instance) {
        prefs(ctx).edit().remove(PREFIX + instance).apply();
    }
}
