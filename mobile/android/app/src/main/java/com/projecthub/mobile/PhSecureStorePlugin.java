package com.projecthub.mobile;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Хранилище ключа и токена устройства (TASK-140.8, decision-79 п. 2). Ключ AES-256-GCM живёт в
 * Android Keystore и наружу не извлекается; в SharedPreferences лежит только шифртекст
 * (IV + данные). Криптография — только средствами ОС, своей библиотеки нет (decision-79 п. 10).
 * В хранилище WebView (localStorage, IndexedDB) профиль не пишется никогда.
 */
@CapacitorPlugin(name = "PhSecureStore", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class PhSecureStorePlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String PREFS = "ph_secure_store";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
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
            ret.put("value", new String(SecureBox.open(stored), StandardCharsets.UTF_8));
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
            prefs().edit().putString(k, SecureBox.seal(value.getBytes(StandardCharsets.UTF_8))).apply();
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
        final String title = call.getString("title", getContext().getString(R.string.biometric_title));
        final String subtitle = call.getString("subtitle", "");
        final String description = call.getString("description", "");
        getActivity().runOnUiThread(() -> {
            Executor executor = getContext().getMainExecutor();
            BiometricPrompt.Builder builder = new BiometricPrompt.Builder(getContext())
                .setTitle(title)
                .setNegativeButton(getContext().getString(R.string.biometric_cancel), executor, (dialog, which) -> call.reject("cancelled", "cancelled"));
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

    // ── Push с ПК (TASK-140.3, decision-115): UnifiedPush, свой ключ RFC 8291 у каждого ПК ──

    private static PhSecureStorePlugin current;
    /** Уведомление, по которому открыли приложение: какой ПК показать. */
    private static JSObject launchTarget;

    @Override
    public void load() {
        current = this;
        if (getActivity() != null) deliverLaunch(getActivity().getIntent());
    }

    /** Нажатие уведомления: MainActivity передаёт намерение сюда, клиент переключается на этот ПК. */
    static void deliverLaunch(Intent intent) {
        if (intent == null || !PushNotifier.ACTION_OPEN.equals(intent.getAction())) return;
        String instance = intent.getStringExtra(PushNotifier.EXTRA_INSTANCE);
        if (instance == null || instance.isEmpty()) return;
        JSObject target = new JSObject();
        target.put("instance", instance);
        target.put("requestId", intent.getStringExtra(PushNotifier.EXTRA_REQUEST));
        launchTarget = target;
        // Повторная доставка того же намерения после поворота экрана не нужна.
        intent.setAction(Intent.ACTION_MAIN);
        if (current != null) current.notifyListeners("launchTarget", target, true);
    }

    static void notifyEndpointChanged(String instance, String endpoint) {
        if (current == null) return;
        JSObject data = new JSObject();
        data.put("instance", instance);
        data.put("endpoint", endpoint);
        current.notifyListeners("pushEndpoint", data);
    }

    @PluginMethod
    public void takeLaunchTarget(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("target", launchTarget);
        launchTarget = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void pushDistributors(PluginCall call) {
        JSArray list = new JSArray();
        for (String pkg : UnifiedPush.distributors(getContext())) list.put(pkg);
        JSObject ret = new JSObject();
        ret.put("distributors", list);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    /**
     * Включить push с одного ПК: новые ключи, регистрация у дистрибьютора, ответ — адрес и открытые ключи для
     * `push_register` на этом ПК. Закрытый ключ остаётся в хранилище телефона.
     */
    @PluginMethod
    public void pushRegister(PluginCall call) {
        String instance = call.getString("instance");
        if (instance == null || !instance.matches("[A-Za-z0-9_.-]{1,96}")) {
            call.reject("instance is required", "bad_instance");
            return;
        }
        List<String> distributors = UnifiedPush.distributors(getContext());
        String distributor = call.getString("distributor");
        if (distributor == null || !distributors.contains(distributor)) distributor = distributors.isEmpty() ? null : distributors.get(0);
        if (distributor == null) {
            call.reject("no UnifiedPush distributor", "no_distributor");
            return;
        }
        final PushRegistry.Reg reg;
        try {
            reg = PushRegistry.create(getContext(), instance, call.getString("label", "ProjectHub"), distributor);
        } catch (Exception e) {
            call.reject("push keys failed", "failed");
            return;
        }
        final AtomicBoolean settled = new AtomicBoolean(false);
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> {
            if (settled.compareAndSet(false, true)) {
                UnifiedPush.cancelWait(reg.token);
                call.reject("distributor did not answer", "timeout");
            }
        }, 20_000);
        UnifiedPush.register(getContext(), reg, "ProjectHub: " + reg.label, new UnifiedPush.EndpointListener() {
            @Override
            public void onEndpoint(String endpoint) {
                if (!settled.compareAndSet(false, true)) return;
                JSObject ret = new JSObject();
                ret.put("kind", "unifiedpush");
                ret.put("endpoint", endpoint);
                ret.put("p256dh", PushRegistry.b64(reg.publicPoint));
                ret.put("auth", PushRegistry.b64(reg.auth));
                ret.put("actionKey", PushRegistry.b64(reg.actionKey));
                ret.put("distributor", reg.distributor);
                call.resolve(ret);
            }

            @Override
            public void onFailed(String reason) {
                if (!settled.compareAndSet(false, true)) return;
                call.reject("registration failed: " + reason, "failed");
            }
        });
    }

    @PluginMethod
    public void pushUnregister(PluginCall call) {
        String instance = call.getString("instance");
        PushRegistry.Reg reg = instance == null ? null : PushRegistry.get(getContext(), instance);
        if (reg != null) {
            UnifiedPush.unregister(getContext(), reg);
            PushRegistry.remove(getContext(), instance);
        }
        call.resolve();
    }
}
