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
            CommandMenu("Host") {
                Button("เปิด log ของ host") {
                    NSWorkspace.shared.open(HostSupervisor.logFile)
                }
                Button("เปิดโฟลเดอร์ state") {
                    NSWorkspace.shared.open(HostSupervisor.stateDir)
                }
                Divider()
                Button("รีสตาร์ท host") {
                    Task { _ = try? await HostSupervisor.restart() }
                }
                Button("หยุด host + agents") {
                    Task { await HostSupervisor.stopHostAndAgents() }
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
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
}
