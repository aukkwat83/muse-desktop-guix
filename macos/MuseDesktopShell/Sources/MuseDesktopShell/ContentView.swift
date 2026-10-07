import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var model = BrowserModel()
    @State private var statusText = "กำลังเริ่ม host…"
    @State private var meterLine = ""
    @State private var showError: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "moon.stars")
                    .foregroundStyle(.secondary)
                Text(statusText)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if !meterLine.isEmpty {
                    Text(meterLine)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .help("agents ที่ยังอุ่นอยู่ · หน่วยความจำว่าง (จาก /api/memory)")
                }
                Spacer()
                if model.isLoading {
                    ProgressView().controlSize(.small)
                }
                Button {
                    model.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("r", modifiers: .command)
                .help("โหลด UI ใหม่ (⌘R) — ข้าม cache")

                Button {
                    Task { await model.reensureHost() }
                } label: {
                    Image(systemName: "bolt.horizontal.circle")
                }
                .buttonStyle(.borderless)
                .help("ตรวจว่า host ยังทำงานอยู่")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            ZStack {
                WebView(model: model)
                    .background(Color(nsColor: .windowBackgroundColor))

                if let err = showError {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 36))
                            .foregroundStyle(.orange)
                        Text("Muse Desktop").font(.title2.bold())
                        Text(err)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 440)
                        Button("ลองใหม่") {
                            showError = nil
                            Task { await bootstrap() }
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                    .padding(32)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
        }
        .frame(minWidth: 900, minHeight: 620)
        .task { await bootstrap() }
        .task { await pollMeter() }
        .onChange(of: model.pageTitle) { _, title in
            if !title.isEmpty { statusText = title }
        }
    }

    @MainActor
    private func bootstrap() async {
        statusText = "กำลังเริ่ม Node host…"
        do {
            let url = try await HostSupervisor.ensureRunning()
            statusText = "เชื่อมต่อแล้ว · 127.0.0.1:\(HostSupervisor.port)"
            model.load(url)
        } catch {
            showError = error.localizedDescription
            statusText = "host มีปัญหา"
        }
    }

    @MainActor
    private func pollMeter() async {
        while !Task.isCancelled {
            if let line = await Self.fetchMeter() { meterLine = line }
            try? await Task.sleep(nanoseconds: 8_000_000_000)
        }
    }

    private static func fetchMeter() async -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(HostSupervisor.port)/api/memory") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2.5
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["ok"] as? Bool) == true
            else { return nil }
            let freeMB = (obj["freeMB"] as? NSNumber)?.doubleValue ?? 0
            let counts = obj["counts"] as? [String: Any]
            let hot = (counts?["hot"] as? NSNumber)?.intValue ?? 0
            let maxHot = (obj["maxHotAgents"] as? NSNumber)?.intValue ?? 0
            return String(format: "agents %d/%d · free %.1fG", hot, maxHot, freeMB / 1024)
        } catch {
            return nil
        }
    }
}

@MainActor
final class BrowserModel: ObservableObject {
    @Published var isLoading = false
    @Published var pageTitle = ""
    weak var webView: WKWebView?
    private(set) var pendingURL: URL?

    func load(_ url: URL) {
        pendingURL = url
        webView?.load(URLRequest(url: url))
    }

    func reload() {
        // Purge the HTTP cache first: WKWebView will otherwise keep serving a
        // stale bundle after an edit, which reads as "my change did nothing".
        let types: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        (webView?.configuration.websiteDataStore ?? WKWebsiteDataStore.default())
            .removeData(ofTypes: types, modifiedSince: .distantPast) {}
        if let u = pendingURL {
            var req = URLRequest(url: u)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            webView?.load(req)
        } else {
            webView?.reloadFromOrigin()
        }
    }

    func reensureHost() async {
        _ = try? await HostSupervisor.ensureRunning()
        reload()
    }
}

struct WebView: NSViewRepresentable {
    @ObservedObject var model: BrowserModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .default()
        config.mediaTypesRequiringUserActionForPlayback = .all

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        wv.allowsBackForwardNavigationGestures = false
        wv.wantsLayer = true
        wv.layer?.drawsAsynchronously = true
        if #available(macOS 13.3, *) { wv.isInspectable = true }
        model.webView = wv
        if let u = model.pendingURL { wv.load(URLRequest(url: u)) }
        return wv
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        model.webView = nsView
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: BrowserModel
        init(model: BrowserModel) { self.model = model }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            model.isLoading = true
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.isLoading = false
            model.pageTitle = webView.title ?? "Muse Desktop"
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            model.isLoading = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            model.isLoading = false
        }

        /// The app is the local host and nothing else — anything off-origin is
        /// a link the user clicked, and belongs in their real browser.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if let url = navigationAction.request.url,
               let host = url.host,
               host != "127.0.0.1", host != "localhost" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        /// ⧉ pop-out: the rail's "open in new window" button (window.open to
        /// a same-origin child page) lands here — without this delegate,
        /// WKWebView silently drops the popup. Same-origin only, like the
        /// navigation policy above; anything else goes to the real browser.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            if let host = url.host, host != "127.0.0.1", host != "localhost" {
                NSWorkspace.shared.open(url)
                return nil
            }
            let popup = WKWebView(frame: .zero, configuration: configuration)
            popup.navigationDelegate = self
            popup.uiDelegate = self
            let win = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 700),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            win.contentView = popup
            win.title = "Muse Desktop — child session"
            win.makeKeyAndOrderFront(nil)
            popup.load(URLRequest(url: url))
            return popup
        }

        // Without these, window.confirm/prompt return instantly — the "change
        // working directory" and "delete chat" flows would silently do nothing.
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = "Muse Desktop"
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            alert.beginSheetModal(for: webView.window ?? NSApp.keyWindow ?? NSWindow()) { _ in
                completionHandler()
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = "Muse Desktop"
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: webView.window ?? NSApp.keyWindow ?? NSWindow()) { resp in
                completionHandler(resp == .alertFirstButtonReturn)
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = "Muse Desktop"
            alert.informativeText = prompt
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
            field.stringValue = defaultText ?? ""
            alert.accessoryView = field
            alert.window.initialFirstResponder = field
            alert.beginSheetModal(for: webView.window ?? NSApp.keyWindow ?? NSWindow()) { resp in
                completionHandler(resp == .alertFirstButtonReturn ? field.stringValue : nil)
            }
        }
    }
}
