#if DEBUG
import WebKit

/**
 Debug-only self-test of the iOS shell (TASK-140.18), run by `npm run mobile:ios:selftest` in the simulator. Launched
 with `-phSelfTest <ws url>`, the page checks what differs from Android — secure context and WebCrypto in WKWebView, the
 Keychain plugin, `ws://` to a LAN address from the `capacitor://` origin — and logs one `PH_SELFTEST {json}` line.
 Release builds do not contain it.
 */
enum SelfTest {
    static func attachIfRequested(to webView: WKWebView?) {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-phSelfTest"), index + 1 < args.count, let webView = webView else { return }
        guard let urlData = try? JSONSerialization.data(withJSONObject: [args[index + 1]]),
              let urlArray = String(data: urlData, encoding: .utf8) else { return }
        let source = """
        setTimeout(async () => {
          const wsUrl = \(urlArray)[0];
          const r = { secureContext: window.isSecureContext, subtle: !!(window.crypto && crypto.subtle), origin: location.origin };
          try { await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); r.ecdhP256 = true; } catch (e) { r.ecdhP256 = String(e); }
          try { await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']); r.x25519 = true; } catch (e) { r.x25519 = String(e); }
          const C = window.Capacitor;
          r.platform = C.getPlatform();
          r.plugins = { PhSecureStore: C.isPluginAvailable('PhSecureStore'), PhTts: C.isPluginAvailable('PhTts'), Haptics: C.isPluginAvailable('Haptics') };
          const store = C.registerPlugin('PhSecureStore');
          try {
            const value = 'ok-' + Date.now();
            await store.set({ key: 'ph_selftest', value });
            r.keychainRoundTrip = (await store.get({ key: 'ph_selftest' })).value === value;
            await store.remove({ key: 'ph_selftest' });
            r.keychainRemoved = (await store.get({ key: 'ph_selftest' })).value == null;
          } catch (e) { r.keychainRoundTrip = 'ERR ' + (e.message || e); }
          try { r.confirmStatus = await store.confirmStatus(); } catch (e) { r.confirmStatus = String(e); }
          try { r.tts = await C.registerPlugin('PhTts').isAvailable(); } catch (e) { r.tts = String(e); }
          r.localStorageKeys = Object.keys(localStorage);
          r.ws = await new Promise((resolve) => {
            try {
              const ws = new WebSocket(wsUrl);
              const timer = setTimeout(() => resolve('timeout'), 8000);
              ws.onopen = () => { clearTimeout(timer); ws.close(); resolve('open'); };
              ws.onerror = () => { clearTimeout(timer); resolve('error'); };
            } catch (e) { resolve('throw ' + e); }
          });
          console.log('PH_SELFTEST ' + JSON.stringify(r));
        }, 1500);
        """
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
    }
}
#endif
