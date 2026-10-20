package com.projecthub.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Шифрование записей хранилища ключом AES-256-GCM из Android Keystore (TASK-140.8, decision-81 п. 5). Ключ не
 * извлекается, на диске — только IV и шифртекст. Общий для плагина PhSecureStore и приёмников push
 * (TASK-140.3), которые работают без WebView.
 */
final class SecureBox {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "projecthub_device_store";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private SecureBox() {}

    private static synchronized SecretKey key() throws Exception {
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

    /** IV + шифртекст в base64. */
    static String seal(byte[] plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] data = cipher.doFinal(plain);
        ByteBuffer buf = ByteBuffer.allocate(iv.length + data.length);
        buf.put(iv);
        buf.put(data);
        return Base64.encodeToString(buf.array(), Base64.NO_WRAP);
    }

    /** Ошибка — ключ Keystore утерян или запись повреждена: вызывающий удаляет запись. */
    static byte[] open(String stored) throws Exception {
        byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
        ByteBuffer buf = ByteBuffer.wrap(blob);
        byte[] iv = new byte[IV_BYTES];
        buf.get(iv);
        byte[] data = new byte[buf.remaining()];
        buf.get(data);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        return cipher.doFinal(data);
    }
}
