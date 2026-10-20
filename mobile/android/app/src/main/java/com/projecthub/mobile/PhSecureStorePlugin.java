package com.projecthub.mobile;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.concurrent.Executor;

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

    // ── Ключ подтверждения решений HITL биометрией (TASK-140.6, decision-112 п. 4, decision-114) ──
    //
    // ECDSA P-256 в Android Keystore, свой у каждого сопряжения. Закрытая часть не извлекается и
    // требует сильную биометрию на каждую подпись: Signature разблокируется только через
    // BiometricPrompt с CryptoObject. Новый отпечаток в системе делает ключ недействительным —
    // устройство сопрягают заново, как ключ WebAuthn.

    private static final String CONFIRM_PREFIX = "projecthub_confirm_";

    private static String confirmAlias(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !id.matches("[A-Za-z0-9_.-]{1,96}")) {
            call.reject("id is required", "bad_id");
            return null;
        }
        return CONFIRM_PREFIX + id;
    }

    /** Почему биометрия недоступна; `null` — доступна. */
    private String biometricUnavailableReason() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "unsupported";
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        if (keyguard == null || !keyguard.isDeviceSecure()) return "no_lock";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            BiometricManager bm = getContext().getSystemService(BiometricManager.class);
            if (bm == null) return "no_hardware";
            int code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                : bm.canAuthenticate();
            if (code == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) return "not_enrolled";
            if (code == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE) return "no_hardware";
            if (code != BiometricManager.BIOMETRIC_SUCCESS) return "unavailable";
        }
        return null;
    }

    @PluginMethod
    public void confirmStatus(PluginCall call) {
        String reason = biometricUnavailableReason();
        JSObject ret = new JSObject();
        ret.put("available", reason == null);
        if (reason != null) ret.put("reason", reason);
        call.resolve(ret);
    }

    /** Новый ключ сопряжения (прежний с тем же id заменяется). Возвращает SPKI DER в base64url. */
    @PluginMethod
    public void createConfirmKey(PluginCall call) {
        String alias = confirmAlias(call);
        if (alias == null) return;
        String reason = biometricUnavailableReason();
        if (reason != null) {
            call.reject("biometric unavailable: " + reason, reason);
            return;
        }
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
            KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // 0 секунд — биометрия на каждую подпись, только сильная (класс 3).
                spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            } else {
                spec.setUserAuthenticationValidityDurationSeconds(-1);
            }
            KeyPairGenerator gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
            gen.initialize(spec.build());
            KeyPair pair = gen.generateKeyPair();
            JSObject ret = new JSObject();
            ret.put("publicKey", Base64.encodeToString(pair.getPublic().getEncoded(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("confirm key generation failed", "failed");
        }
    }

    /** Подпись строки решения после BiometricPrompt. Возвращает подпись DER в base64url. */
    @PluginMethod
    public void signConfirm(PluginCall call) {
        String alias = confirmAlias(call);
        if (alias == null) return;
        String payload = call.getString("payload");
        if (payload == null || payload.isEmpty() || payload.length() > 4096) {
            call.reject("payload is required", "bad_payload");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            call.reject("biometric unavailable", "unsupported");
            return;
        }
        final Signature signature;
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            if (!ks.containsAlias(alias)) {
                call.reject("no confirm key", "no_key");
                return;
            }
            PrivateKey key = (PrivateKey) ks.getKey(alias, null);
            signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(key);
        } catch (KeyPermanentlyInvalidatedException e) {
            // Добавили отпечаток или сняли блокировку экрана — ключ больше не годится.
            call.reject("confirm key invalidated", "invalidated");
            return;
        } catch (Exception e) {
            call.reject("confirm key unavailable", "no_key");
            return;
        }
        final byte[] data = payload.getBytes(StandardCharsets.UTF_8);
        final String title = call.getString("title", "Подтвердите решение");
        final String subtitle = call.getString("subtitle", "");
        final String description = call.getString("description", "");
        getActivity().runOnUiThread(() -> {
            Executor executor = getContext().getMainExecutor();
            BiometricPrompt.Builder builder = new BiometricPrompt.Builder(getContext())
                .setTitle(title)
                .setNegativeButton("Отмена", executor, (dialog, which) -> call.reject("cancelled", "cancelled"));
            if (!subtitle.isEmpty()) builder.setSubtitle(subtitle);
            if (!description.isEmpty()) builder.setDescription(description);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
            }
            builder.build().authenticate(
                new BiometricPrompt.CryptoObject(signature),
                new CancellationSignal(),
                executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            Signature unlocked = result.getCryptoObject().getSignature();
                            unlocked.update(data);
                            JSObject ret = new JSObject();
                            ret.put("signature", Base64.encodeToString(unlocked.sign(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
                            call.resolve(ret);
                        } catch (Exception e) {
                            call.reject("sign failed", "failed");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errString) {
                        // Кнопку «Отмена» обрабатывает её слушатель (setNegativeButton), сюда она не приходит.
                        boolean cancelled = errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED
                            || errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED;
                        boolean lockout = errorCode == BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT
                            || errorCode == BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT;
                        call.reject(String.valueOf(errString), cancelled ? "cancelled" : lockout ? "lockout" : "failed");
                    }
                    // onAuthenticationFailed — неузнанный палец: подсказку показывает сам диалог, ждём следующей попытки.
                }
            );
        });
    }

    @PluginMethod
    public void deleteConfirmKey(PluginCall call) {
        String alias = confirmAlias(call);
        if (alias == null) return;
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        } catch (Exception e) {
            // Нечего удалять — ключ уже недоступен.
        }
        call.resolve();
    }
}
