import UIKit
import WebKit
import Capacitor

/**
 Bridge controller of the iOS shell (TASK-140.18): registers the local plugins and hands the launch screen over to the
 WebView, as MainActivity does on Android.
 */
class MainViewController: CAPBridgeViewController {
    /** Launch screen color (`ph_splash` on Android): visible until the page paints its own launch screen. */
    static let splashColor = UIColor(red: 12 / 255, green: 28 / 255, blue: 49 / 255, alpha: 1)

    override func capacitorDidLoad() {
        // Local plugins are registered before the page loads (TASK-140.8 on Android).
        bridge?.registerPluginInstance(PhSecureStorePlugin())
        // Voice mode speech (TASK-179.2).
        bridge?.registerPluginInstance(PhTtsPlugin())

        view.backgroundColor = MainViewController.splashColor
        // The system launch screen is already gone when the page paints: the web intro starts right away instead of
        // waiting for the launchScreen.ts fallback. The logo stays in place, so the swap is not visible.
        let startIntro = WKUserScript(
            source: "document.getElementById('launch')?.classList.add('l-go')",
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        webView?.configuration.userContentController.addUserScript(startIntro)

        #if DEBUG
        SelfTest.attachIfRequested(to: webView)
        #endif
    }
}
