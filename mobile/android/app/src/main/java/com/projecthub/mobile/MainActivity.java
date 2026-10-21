package com.projecthub.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /** Сколько ждать страницу, прежде чем убрать системный Launch Screen в любом случае. */
    private static final long LAUNCH_FALLBACK_MS = 2500;

    private volatile boolean pageShown = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Системный Launch Screen держится, пока WebView не отрисует страницу: на ней тот же логотип на том же
        // месте, анимация продолжается уже в вебе, а пустого кадра между ними нет.
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !pageShown);
        // Веб-заставка стоит на паузе, пока системный экран её закрывает, и стартует, когда он ушёл: иначе логотип
        // успевает сдвинуться под ним и при подмене прыгает.
        splash.setOnExitAnimationListener((view) ->
            view.getView().animate().alpha(0f).setDuration(200).withEndAction(() -> {
                view.remove();
                startWebIntro();
            }).start()
        );
        new Handler(Looper.getMainLooper()).postDelayed(() -> pageShown = true, LAUNCH_FALLBACK_MS);

        // Локальные плагины регистрируются до старта моста (TASK-140.8).
        registerPlugin(PhSecureStorePlugin.class);
        // Нажатие push при закрытом приложении (TASK-140.3): цель запоминается до старта моста.
        PhSecureStorePlugin.deliverLaunch(getIntent());
        super.onCreate(savedInstanceState);

        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    pageShown = true;
                }

                @Override
                public void onReceivedError(WebView webView) {
                    pageShown = true;
                }
            });
        } else {
            pageShown = true;
        }
    }

    private void startWebIntro() {
        if (bridge == null || bridge.getWebView() == null) return;
        bridge.getWebView().evaluateJavascript("document.getElementById('launch')?.classList.add('l-go')", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Нажатие push при открытом приложении: переключиться на ПК из уведомления.
        PhSecureStorePlugin.deliverLaunch(intent);
    }
}
