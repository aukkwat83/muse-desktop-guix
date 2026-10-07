import SwiftUI
import AppKit

@main
struct MuseDesktopShellApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup("Muse Desktop") {
            ContentView()
        }
        .defaultSize(width: 1240, height: 820)
        .commands {
            CommandGroup(replacing: .newItem) {}
            // NOTE (BUG-081): the Host menu is deliberately NOT a SwiftUI
            // CommandMenu — see AppDelegate.installHostMenu. SwiftUI Button
            // titles are Swift-native strings, and a non-ASCII one traps in
            // NSMenuItem._description on highlight. Do not move the Host menu
            // back here without re-proving scripts/probe-menu-titles.swift.
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        Self.installHostMenu()
    }

    /// Closing the window is not quitting: an agent may be minutes into a task.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            for window in NSApp.windows { window.makeKeyAndOrderFront(nil) }
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Deliberately does not stop the host — use Host ▸ หยุด host + agents.
        NSLog("[MuseDesktopShell] UI exiting; host and agents kept running")
    }

    // MARK: - Host menu (BUG-081, raw AppKit)

    private static var hostMenuInstalled = false

    /// Forces Foundation-owned string storage for a menu title.
    ///
    /// An NSMenuItem whose title is a Swift-native (UTF-8-backed) string with
    /// any non-ASCII text traps inside `-[NSMenuItem _description:]`
    /// (__StringStorage.getCharacters → String.UTF16View._indexRange
    /// assertion → SIGTRAP). AppKit formats that description on every menu
    /// highlight via _NSNoteInCrashReports, so merely opening the menu
    /// crashed the app the instant the mouse touched an item. Thai, Chinese,
    /// emoji and even French accents all reproduce; ASCII is fine. Keep every
    /// Host title behind this helper — test-mac-app.mjs pins it and
    /// scripts/probe-menu-titles.swift re-proves the mechanism.
    private static func nsTitle(_ s: String) -> String {
        NSString(string: s) as String
    }

    private static func installHostMenu() {
        guard !hostMenuInstalled else { return }
        guard let mainMenu = NSApp.mainMenu else {
            // SwiftUI may install the main menu a tick after us — one retry.
            DispatchQueue.main.async { installHostMenu() }
            return
        }
        hostMenuInstalled = true
        let hostItem = NSMenuItem(title: nsTitle("Host"), action: nil, keyEquivalent: "")
        let menu = NSMenu(title: nsTitle("Host"))
        menu.addItem(NSMenuItem(title: nsTitle("เปิด log ของ host"), action: #selector(openHostLog), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: nsTitle("เปิดโฟลเดอร์ state"), action: #selector(openStateDir), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: nsTitle("รีสตาร์ท host"), action: #selector(restartHost), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: nsTitle("หยุด host + agents"), action: #selector(stopHostAndAgents), keyEquivalent: ""))
        hostItem.submenu = menu
        if let windowIndex = mainMenu.items.firstIndex(where: { $0.title == "Window" }) {
            mainMenu.insertItem(hostItem, at: windowIndex)
        } else {
            mainMenu.addItem(hostItem)
        }
    }

    @objc private func openHostLog() {
        NSWorkspace.shared.open(HostSupervisor.logFile)
    }

    @objc private func openStateDir() {
        NSWorkspace.shared.open(HostSupervisor.stateDir)
    }

    @objc private func restartHost() {
        Task { _ = try? await HostSupervisor.restart() }
    }

    @objc private func stopHostAndAgents() {
        Task { await HostSupervisor.stopHostAndAgents() }
    }
}
