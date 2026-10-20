package com.projecthub.mobile;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Расшифровка push по RFC 8291 (Web Push, кодировка aes128gcm) — TASK-140.3, decision-115. Ключ P-256 и секрет
 * auth создаются при включении push для ПК; хост шифрует каждое уведомление новым эфемерным ключом. Только
 * криптография ОС (ECDH, HMAC-SHA256, AES-GCM), своей библиотеки нет (decision-79 п. 10).
 */
final class WebPush {
    private WebPush() {}

    static KeyPair generateKeyPair() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
        gen.initialize(new ECGenParameterSpec("secp256r1"));
        return gen.generateKeyPair();
    }

    private static byte[] fixed32(BigInteger v) {
        byte[] raw = v.toByteArray();
        byte[] out = new byte[32];
        if (raw.length > 32) System.arraycopy(raw, raw.length - 32, out, 0, 32);
        else System.arraycopy(raw, 0, out, 32 - raw.length, raw.length);
        return out;
    }

    /** Несжатая точка: 0x04 ‖ x ‖ y, 65 байт. */
    static byte[] uncompressed(PublicKey key) {
        ECPoint w = ((ECPublicKey) key).getW();
        byte[] out = new byte[65];
        out[0] = 0x04;
        System.arraycopy(fixed32(w.getAffineX()), 0, out, 1, 32);
        System.arraycopy(fixed32(w.getAffineY()), 0, out, 33, 32);
        return out;
    }

    static PrivateKey privateFromPkcs8(byte[] pkcs8) throws Exception {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
    }

    static PublicKey publicFromPoint(byte[] point, ECParameterSpec params) throws Exception {
        if (point.length != 65 || point[0] != 0x04) throw new IllegalArgumentException("bad point");
        BigInteger x = new BigInteger(1, Arrays.copyOfRange(point, 1, 33));
        BigInteger y = new BigInteger(1, Arrays.copyOfRange(point, 33, 65));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), params));
    }

    private static byte[] hmac(byte[] key, byte[]... parts) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) mac.update(p);
        return mac.doFinal();
    }

    /** HKDF-SHA256 (RFC 5869) на HMAC ОС; здесь длина не больше одного блока. */
    private static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int length) throws Exception {
        byte[] prk = hmac(salt, ikm);
        byte[] okm = hmac(prk, info, new byte[] { 0x01 });
        return Arrays.copyOf(okm, length);
    }

    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        ByteBuffer buf = ByteBuffer.allocate(n);
        for (byte[] p : parts) buf.put(p);
        return buf.array();
    }

    /**
     * Одна запись aes128gcm. Ошибка (чужой ключ, подделка) — исключение: уведомление показывает нейтральный текст.
     */
    static byte[] decrypt(byte[] message, PrivateKey uaPrivate, PublicKey uaPublic, byte[] authSecret) throws Exception {
        if (message.length < 21 + 65 + 17) throw new IllegalArgumentException("short");
        byte[] salt = Arrays.copyOfRange(message, 0, 16);
        int idLen = message[20] & 0xff;
        byte[] asPublic = Arrays.copyOfRange(message, 21, 21 + idLen);
        byte[] data = Arrays.copyOfRange(message, 21 + idLen, message.length);

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(uaPrivate);
        agreement.doPhase(publicFromPoint(asPublic, ((ECPublicKey) uaPublic).getParams()), true);
        byte[] ecdhSecret = agreement.generateSecret();

        byte[] uaPoint = uncompressed(uaPublic);
        byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.ISO_8859_1), uaPoint, asPublic);
        byte[] ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
        byte[] cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.ISO_8859_1), 16);
        byte[] nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0".getBytes(StandardCharsets.ISO_8859_1), 12);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] padded = cipher.doFinal(data);
        int end = padded.length - 1;
        while (end >= 0 && padded[end] == 0) end--;
        if (end < 0 || padded[end] != 0x02) throw new IllegalArgumentException("bad delimiter");
        return Arrays.copyOf(padded, end);
    }

    /** HMAC кнопки уведомления (`pushActionMac` на хосте), base64url без дополнения. */
    static byte[] actionMac(byte[] actionKey, String text) throws Exception {
        return hmac(actionKey, text.getBytes(StandardCharsets.UTF_8));
    }
}
