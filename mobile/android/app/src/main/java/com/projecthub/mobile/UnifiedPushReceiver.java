package com.projecthub.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.interfaces.ECPrivateKey;

/**
 * Приёмник дистрибьютора UnifiedPush (TASK-140.3, decision-115). Работает и при закрытом приложении: система
 * поднимает процесс ради широковещательного намерения. Расшифровывает push ключом этого ПК и показывает уведомление;
 * если расшифровать не удалось — нейтральный текст.
 */
public class UnifiedPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        Context ctx = context.getApplicationContext();
        String token = intent.getStringExtra("token");
        PushRegistry.Reg reg = PushRegistry.byToken(ctx, token);
        switch (action) {
            case UnifiedPush.NEW_ENDPOINT: {
                String endpoint = intent.getStringExtra("endpoint");
                if (reg != null && endpoint != null) {
                    reg.endpoint = endpoint;
                    try {
                        PushRegistry.save(ctx, reg);
                    } catch (Exception e) {
                        // запись не сохранилась — ниже сообщим об ошибке
                    }
                    PhSecureStorePlugin.notifyEndpointChanged(reg.instance, endpoint);
                }
                UnifiedPush.EndpointListener listener = UnifiedPush.takeListener(token);
                if (listener != null) {
                    if (endpoint != null) listener.onEndpoint(endpoint);
                    else listener.onFailed("no_endpoint");
                }
                if (reg != null) UnifiedPush.ack(ctx, reg, intent.getStringExtra("id"));
                break;
            }
            case UnifiedPush.REGISTRATION_FAILED: {
                UnifiedPush.EndpointListener listener = UnifiedPush.takeListener(token);
                String reason = intent.getStringExtra("reason");
                if (listener != null) listener.onFailed(reason == null ? "failed" : reason);
                break;
            }
            case UnifiedPush.UNREGISTERED: {
                if (reg != null) {
                    PushRegistry.remove(ctx, reg.instance);
                    PhSecureStorePlugin.notifyEndpointChanged(reg.instance, "");
                }
                break;
            }
            case UnifiedPush.MESSAGE: {
                if (reg == null) {
                    // Регистрация забыта (переустановка, «Забыть компьютер»): пусть дистрибьютор удалит адрес,
                    // и ПК, получив отказ, снимет регистрацию у себя.
                    UnifiedPush.unregisterUnknown(ctx, token);
                    return;
                }
                byte[] body = intent.getByteArrayExtra("bytesMessage");
                // AND_2 до bytesMessage передавал текст полем message.
                if (body == null && intent.getStringExtra("message") != null) body = intent.getStringExtra("message").getBytes(StandardCharsets.ISO_8859_1);
                try {
                    byte[] plain = WebPush.decrypt(body, WebPush.privateFromPkcs8(reg.privatePkcs8), publicOf(reg), reg.auth);
                    PushNotifier.show(ctx, reg, plain);
                } catch (Exception e) {
                    PushNotifier.showNeutral(ctx, reg);
                }
                UnifiedPush.ack(ctx, reg, intent.getStringExtra("id"));
                break;
            }
            default:
                break;
        }
    }

    /** Открытый ключ из сохранённой точки; параметры кривой — из закрытого ключа той же регистрации. */
    private static PublicKey publicOf(PushRegistry.Reg reg) throws Exception {
        ECPrivateKey priv = (ECPrivateKey) WebPush.privateFromPkcs8(reg.privatePkcs8);
        return WebPush.publicFromPoint(reg.publicPoint, priv.getParams());
    }
}
