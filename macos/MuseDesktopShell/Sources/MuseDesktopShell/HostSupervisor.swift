import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Owns the lifetime of the Node host (`src/server/index.js`).
///
/// The window is a view, not the app: closing it leaves the host — and any
/// agent mid-task — running. Only an explicit *Stop Host + Agents* tears it
/// down.
///
/// Every kill path here verifies ownership first. A pid file alone is not
/// proof: it goes stale across crashes, and macOS recycles pids, so signalling
/// a pid we merely *read* can hit an unrelated process. The host publishes its
/// own pid at `/api/state`, and that is what we check against.
enum HostSupervisor {
    static let host = "127.0.0.1"
    static let port = Int(ProcessInfo.processInfo.environment["MUSE_DESKTOP_PORT"] ?? "3850") ?? 3850
    static var baseURL: URL { URL(string: "http://\(host):\(port)/")! }
    static var healthURL: URL { URL(string: "http://\(host):\(port)/api/state")! }
    static var shutdownURL: URL { URL(string: "http://\(host):\(port)/api/host/shutdown")! }

    /// Serialises ensureRunning/restart so concurrent UI actions share a flight.
    private static let lifecycleGate = LifecycleGate()

    /// Repo root — `…/macos/MuseDesktopShell` is two levels down from it.
    static var repoRoot: URL {
        if let env = ProcessInfo.processInfo.environment["MUSE_DESKTOP_ROOT"], !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        let preferred = URL(fileURLWithPath: NSString(string: "~/Applications/muse-desktop").expandingTildeInPath)
        if FileManager.default.fileExists(atPath: preferred.appendingPathComponent("src/server/index.js").path) {
            return preferred
        }
        // Dev builds run out of .build — walk up until the server entry appears.
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        var dir = exe.deletingLastPathComponent()
        for _ in 0..<8 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/server/index.js").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return preferred
    }

    /// XDG state, matching what the Node host and the launch script use.
    static var stateDir: URL {
        let base = ProcessInfo.processInfo.environment["XDG_STATE_HOME"]
            .flatMap { $0.isEmpty ? nil : $0 }
            ?? NSString(string: "~/.local/state").expandingTildeInPath
        let url = URL(fileURLWithPath: base).appendingPathComponent("muse-desktop", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static var pidFile: URL { stateDir.appendingPathComponent("host.pid") }
    static var logFile: URL { stateDir.appendingPathComponent("host.log") }

    // MARK: - Health

    static func isHealthy() async -> Bool {
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    static func fetchStatePid() async -> Int32? {
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            if let n = obj["pid"] as? Int { return Int32(n) }
            if let n = obj["pid"] as? NSNumber { return n.int32Value }
            return nil
        } catch {
            return nil
        }
    }

    // MARK: - Ensure / restart

    @discardableResult
    static func ensureRunning(timeoutSeconds: TimeInterval = 45) async throws -> URL {
        if await isHealthy() { return baseURL }
        return try await lifecycleGate.run {
            if await isHealthy() { return baseURL }
            try startDaemon()
            return try await pollHealthy(timeoutSeconds: timeoutSeconds)
        }
    }

    @discardableResult
    static func restart(timeoutSeconds: TimeInterval = 45) async throws -> URL {
        try await lifecycleGate.run {
            if await requestShutdown(killAgents: false) == false {
                await signalStopVerified(force: false)
                if await isHealthy() { await signalStopVerified(force: true) }
            }
            await waitUntilUnhealthy(timeoutSeconds: min(timeoutSeconds, 20))
            clearPidFile()
            try startDaemon()
            return try await pollHealthy(timeoutSeconds: timeoutSeconds)
        }
    }

    // MARK: - Start

    static func startDaemon() throws {
        let root = repoRoot
        let serverJs = root.appendingPathComponent("src/server/index.js")
        guard FileManager.default.fileExists(atPath: serverJs.path) else {
            throw HostError.missingServer(serverJs.path)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: resolveNode())
        process.arguments = [serverJs.path]
        process.currentDirectoryURL = root

        var env = ProcessInfo.processInfo.environment
        env["MUSE_DESKTOP_PORT"] = String(port)
        env["MUSE_DESKTOP_HOST"] = host
        env["NO_OPEN"] = "1"                      // the Swift window is the UI
        env["MUSE_DESKTOP_KEEP_ON_EXIT"] = "1"    // agents outlive the window
        // `muse` ships next to its launcher under whichever Node installed it, so
        // the app bundle cannot rely on a login shell's PATH.
        env["PATH"] = [
            NSString(string: "~/.local/bin").expandingTildeInPath,
            nodeBinDir() ?? "",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            env["PATH"] ?? "/usr/bin:/bin",
        ].filter { !$0.isEmpty }.joined(separator: ":")
        process.environment = env

        FileManager.default.createFile(atPath: logFile.path, contents: nil)
        let logHandle = try FileHandle(forWritingTo: logFile)
        try logHandle.seekToEnd()
        process.standardOutput = logHandle
        process.standardError = logHandle
        process.standardInput = FileHandle.nullDevice

        try process.run()
        try String(process.processIdentifier).write(to: pidFile, atomically: true, encoding: .utf8)
        NSLog("[MuseDesktopShell] host pid=\(process.processIdentifier) root=\(root.path)")
    }

    // MARK: - Stop

    /// The sanctioned teardown: ask the host to stop over HTTP, and only fall
    /// back to signals — always verified — if it will not answer.
    static func stopHostAndAgents() async {
        if await requestShutdown(killAgents: true) {
            await waitUntilUnhealthy(timeoutSeconds: 20)
            clearPidFile()
            return
        }
        NSLog("[MuseDesktopShell] HTTP shutdown refused — falling back to verified signals")
        await signalStopVerified(force: false)
        if await isHealthy() { await signalStopVerified(force: true) }
        await waitUntilUnhealthy(timeoutSeconds: 8)
        clearPidFile()
    }

    @discardableResult
    static func requestShutdown(killAgents: Bool) async -> Bool {
        var req = URLRequest(url: shutdownURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["killAgents": killAgents])
        req.timeoutInterval = 5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            return code == 202 || code == 200
        } catch {
            // The socket can drop as the host exits after accepting — if it is
            // gone, the shutdown worked.
            return !(await isHealthy())
        }
    }

    // MARK: - PID ownership

    static func readPidFile() -> Int32? {
        guard let s = try? String(contentsOf: pidFile, encoding: .utf8),
              let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 1
        else { return nil }
        return pid
    }

    static func clearPidFile() {
        try? FileManager.default.removeItem(at: pidFile)
    }

    static func isProcessAlive(_ pid: Int32) -> Bool {
        pid > 1 && kill(pid, 0) == 0
    }

    private static func signalStopVerified(force: Bool) async {
        guard let pid = await verifiedOursPid() else {
            NSLog("[MuseDesktopShell] no verified host pid — refusing to signal anything")
            return
        }
        kill(pid, force ? SIGKILL : SIGTERM)
        NSLog("[MuseDesktopShell] \(force ? "SIGKILL" : "SIGTERM") pid=\(pid)")
    }

    /// A pid we are allowed to signal, or nil. The live API pid is authoritative
    /// because only our host answers on our port.
    static func verifiedOursPid() async -> Int32? {
        let filePid = readPidFile()
        let apiPid = await fetchStatePid()

        if let api = apiPid {
            if filePid != api {
                try? String(api).write(to: pidFile, atomically: true, encoding: .utf8)
            }
            return api
        }
        if let file = filePid {
            if !isProcessAlive(file) {
                clearPidFile()
                return nil
            }
            NSLog("[MuseDesktopShell] pid=\(file) alive but /api/state silent — not killing blindly")
            return nil
        }
        return nil
    }

    // MARK: - Waiting

    private static func pollHealthy(timeoutSeconds: TimeInterval) async throws -> URL {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if await isHealthy() { return baseURL }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw HostError.timeoutWaitingForHealth
    }

    private static func waitUntilUnhealthy(timeoutSeconds: TimeInterval) async {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if !(await isHealthy()) { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    // MARK: - Node

    private static func nodeBinDir() -> String? {
        let node = resolveNode()
        guard node != "/usr/bin/node" || FileManager.default.isExecutableFile(atPath: node) else { return nil }
        return URL(fileURLWithPath: node).deletingLastPathComponent().path
    }

    private static func resolveNode() -> String {
        if let env = ProcessInfo.processInfo.environment["NODE_BIN"],
           FileManager.default.isExecutableFile(atPath: env) {
            return env
        }
        // Prefer the newest nvm install so `muse`, resolved through that
        // same Node, is on the resulting PATH.
        let nvm = NSString(string: "~/.nvm/versions/node").expandingTildeInPath
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted(by: >) {
                let candidate = "\(nvm)/\(v)/bin/node"
                if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
            }
        }
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "/usr/bin/node"
    }

    enum HostError: LocalizedError {
        case timeoutWaitingForHealth
        case missingServer(String)

        var errorDescription: String? {
            switch self {
            case .timeoutWaitingForHealth:
                return "หมดเวลารอ host บนพอร์ต \(HostSupervisor.port) — ดู log ที่ \(HostSupervisor.logFile.path)"
            case .missingServer(let p):
                return "ไม่พบไฟล์ server: \(p)"
            }
        }
    }
}

/// Collapses concurrent lifecycle requests into one in-flight operation.
private actor LifecycleGate {
    private var current: Task<URL, Error>?

    func run(_ body: @Sendable @escaping () async throws -> URL) async throws -> URL {
        if let current { return try await current.value }
        let task = Task { try await body() }
        current = task
        defer { current = nil }
        return try await task.value
    }
}
