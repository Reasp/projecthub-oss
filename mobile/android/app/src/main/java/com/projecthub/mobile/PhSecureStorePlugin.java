package com.projecthub.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Хранилище ключа и токена устройства (TASK-140.8, decision-79 п. 2). Ключ AES-256-GCM живёт в
 * Android Keystore и наружу не извлекается; в SharedPreferences лежит только шифртекст
 * (IV + данные). Криптография — только средствами ОС, своей библиотеки нет (decision-79 п. 10).
 * В хранилище WebView (localStorage, IndexedDB) профиль не пишется никогда.
 */
@CapacitorPlugin(name = "PhSecureStore")
public class PhSecureStorePlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "projecthub_device_store";
    private static final String PREFS = "ph_secure_store";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    private static String requireKey(PluginCall call) {
        String k = call.getString("key");
        if (k == null || k.isEmpty()) {
            call.reject("key is required");
            return null;
        }
        return k;
    }

    @PluginMethod
    public void get(PluginCall call) {
        String k = requireKey(call);
        if (k == null) return;
        JSObject ret = new JSObject();
        String stored = prefs().getString(k, null);
        if (stored == null) {
            ret.put("value", null);
            call.resolve(ret);
            return;
        }
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            ByteBuffer buf = ByteBuffer.wrap(blob);
            byte[] iv = new byte[IV_BYTES];
            buf.get(iv);
            byte[] data = new byte[buf.remaining()];
            buf.get(data);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            ret.put("value", new String(cipher.doFinal(data), StandardCharsets.UTF_8));
            call.resolve(ret);
        } catch (Exception e) {
            // Ключ Keystore утерян (сброс блокировки экрана, восстановление из бэкапа) — запись
            // нечитаема: удаляем её, клиент попросит сопрячь устройство заново.
            prefs().edit().remove(k).apply();
            ret.put("value", null);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String k = requireKey(call);
        if (k == null) return;
        String value = call.getString("value");
        if (value == null) {
            call.reject("value is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] data = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            ByteBuffer buf = ByteBuffer.allocate(iv.length + data.length);
            buf.put(iv);
            buf.put(data);
            prefs().edit().putString(k, Base64.encodeToString(buf.array(), Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("secure store write failed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String k = requireKey(call);
        if (k == null) return;
        prefs().edit().remove(k).apply();
        call.resolve();
    }
}
