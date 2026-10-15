package com.projecthub.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Локальные плагины регистрируются до старта моста (TASK-140.8).
        registerPlugin(PhSecureStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
