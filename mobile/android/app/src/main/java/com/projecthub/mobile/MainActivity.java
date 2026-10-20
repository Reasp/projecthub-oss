package com.projecthub.mobile;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Локальные плагины регистрируются до старта моста (TASK-140.8).
        registerPlugin(PhSecureStorePlugin.class);
        // Нажатие push при закрытом приложении (TASK-140.3): цель запоминается до старта моста.
        PhSecureStorePlugin.deliverLaunch(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Нажатие push при открытом приложении: переключиться на ПК из уведомления.
        PhSecureStorePlugin.deliverLaunch(intent);
    }
}
