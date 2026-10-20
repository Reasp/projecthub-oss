package com.projecthub.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECPrivateKeySpec;
import java.math.BigInteger;
import java.util.Base64;

/**
 * Расшифровка push на телефоне (TASK-140.3, decision-115) по тестовому вектору RFC 8291 (раздел 5, приложение A):
 * та же запись, что проверяет хост в tests/unit/phPush.test.ts. Только JVM, без устройства.
 */
public class WebPushTest {
    private static byte[] b(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    private static final String BODY =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    private static final byte[] UA_PUBLIC = b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    private static final byte[] UA_PRIVATE = b("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
    private static final byte[] AUTH = b("BTBZMqHH6r4Tts7J_aSIgg");

    private static PublicKey uaPublic() throws Exception {
        ECPublicKey sample = (ECPublicKey) WebPush.generateKeyPair().getPublic();
        return WebPush.publicFromPoint(UA_PUBLIC, sample.getParams());
    }

    private static PrivateKey uaPrivate() throws Exception {
        ECPublicKey sample = (ECPublicKey) WebPush.generateKeyPair().getPublic();
        return KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, UA_PRIVATE), sample.getParams()));
    }

    @Test
    public void decryptsTheRfc8291Vector() throws Exception {
        byte[] plain = WebPush.decrypt(b(BODY), uaPrivate(), uaPublic(), AUTH);
        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
        assertArrayEquals(UA_PUBLIC, WebPush.uncompressed(uaPublic()));
    }

    @Test
    public void rejectsAWrongAuthSecret() throws Exception {
        byte[] wrong = AUTH.clone();
        wrong[0] ^= 1;
        assertThrows(Exception.class, () -> WebPush.decrypt(b(BODY), uaPrivate(), uaPublic(), wrong));
    }

    @Test
    public void actionMacMatchesTheHost() throws Exception {
        // HMAC-SHA256 RFC 4231, случай 2: ключ "Jefe".
        byte[] mac = WebPush.actionMac("Jefe".getBytes(StandardCharsets.UTF_8), "what do ya want for nothing?");
        assertEquals("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", new BigInteger(1, mac).toString(16));
    }
}
