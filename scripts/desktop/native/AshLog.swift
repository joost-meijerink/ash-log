// Ash Log: the macOS app around the Logboek. One Dock icon, one window that shows the app
// in a WKWebView, and the life cycle of the local app server:
//
//   launch            GET /api/health; when no app server answers, run scripts/desktop/start.sh
//   every 10 seconds  GET /api/health; when the server is gone, offer to start it again
//   window closed     the app and the server keep running (a phone may be using live mode)
//   Dock click        the window comes back
//   Quit, logout      run scripts/desktop/stop.sh, then quit (after 15 seconds at most)
//
// The project folder, the node binary and the port come from Info.plist (AshLogProjectDir,
// AshLogNode, AshLogPort), written by scripts/desktop/build-app.ts. Change this file, then run
// npm run app:install.
//
// Headless, for the tests and for debugging from a terminal (none of these opens a window):
//
//   AshLog --print-config   prints that configuration as JSON
//   AshLog --start-server   starts the server the way the app does, unless it already runs
//   AshLog --stop-server    stops it the way the app does on quit

import AppKit
import WebKit

// MARK: - Configuration

/// The settings build-app.ts bakes into Info.plist.
struct AppConfig: Sendable {
    static let projectDirKey = "AshLogProjectDir"
    static let nodeKey = "AshLogNode"
    static let portKey = "AshLogPort"

    let projectDir: String
    let nodePath: String
    let port: Int

    static func load(from info: [String: Any]) -> Result<AppConfig, ConfigProblem> {
        func absolutePath(_ key: String) -> String? {
            guard let value = info[key] as? String, value.hasPrefix("/") else { return nil }
            return value
        }
        guard let projectDir = absolutePath(projectDirKey) else { return .failure(ConfigProblem(key: projectDirKey)) }
        guard let nodePath = absolutePath(nodeKey) else { return .failure(ConfigProblem(key: nodeKey)) }
        let port = (info[portKey] as? NSNumber)?.intValue ?? (info[portKey] as? String).flatMap { Int($0) }
        guard let port, (1...65535).contains(port) else { return .failure(ConfigProblem(key: portKey)) }
        return .success(AppConfig(projectDir: projectDir, nodePath: nodePath, port: port))
    }

    var projectURL: URL { URL(fileURLWithPath: projectDir, isDirectory: true) }
    var logFile: URL { projectURL.appendingPathComponent(".local/server.log") }
    var appURL: URL { URL(string: "http://localhost:\(port)/")! }
    var healthURL: URL { URL(string: "http://127.0.0.1:\(port)/api/health")! }

    func script(_ name: String) -> URL {
        projectURL.appendingPathComponent("scripts/desktop/\(name)")
    }

    /// The app's own pages: plain http on a loopback name and the app's port.
    func isAppOrigin(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http", url.port == port, let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }

    /// Where a navigation in the window goes. The window shows only the app: its own pages, and
    /// in-page helpers (about:blank, data: and blob: URLs, frames). Web and mail links open in
    /// the default browser, and so does a file to download (the app has no downloads of its
    /// own). Anything else, such as file: or another app's scheme, goes nowhere: a page must
    /// never be able to open files or other apps.
    func route(_ url: URL, subframe: Bool = false, newWindow: Bool = false, download: Bool = false) -> LinkRoute {
        let scheme = url.scheme?.lowercased() ?? ""
        let outside: LinkRoute = ["http", "https", "mailto"].contains(scheme) ? .browser : .nowhere
        if download { return outside }
        if isAppOrigin(url) { return .window }
        // A new window (target=_blank, window.open) never replaces the app with a helper page.
        if newWindow { return outside }
        if subframe || ["about", "data", "blob"].contains(scheme) { return .window }
        return outside
    }

    /// Environment for the desktop scripts. Apps started from the Dock get no shell PATH, so
    /// lib.sh gets node through ASHENFALL_NODE (and puts its folder first on PATH, for tools
    /// that start with #!/usr/bin/env node). The port is the one baked in, so the scripts, the
    /// server and this window always agree on it.
    func scriptEnvironment(base: [String: String]) -> [String: String] {
        var environment = base
        let nodeDir = (nodePath as NSString).deletingLastPathComponent
        let path = base["PATH"].flatMap { $0.isEmpty ? nil : $0 } ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "\(nodeDir):\(path)"
        environment["ASHENFALL_NODE"] = nodePath
        environment["ASHENFALL_PORT"] = String(port)
        return environment
    }

    /// For --print-config.
    var json: String {
        let values: [String: Any] = [
            "projectDir": projectDir,
            "node": nodePath,
            "port": port,
            "appURL": appURL.absoluteString,
            "logFile": logFile.path,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

/// See AppConfig.route.
enum LinkRoute: String, Sendable {
    case window, browser, nowhere
}

struct ConfigProblem: Error {
    let key: String

    var message: String {
        "Ash Log is niet goed geïnstalleerd: \(key) ontbreekt of klopt niet in Info.plist. Installeer de app opnieuw met: npm run app:install"
    }
}

// MARK: - Desktop scripts

/// How a desktop script ended and what it printed.
struct ScriptResult: Sendable {
    let script: String
    let status: Int32
    let output: String
    /// The script could not be read: the project moved, or macOS denies access to the folder.
    var missing = false

    var succeeded: Bool { status == 0 }

    /// The scripts print their Dutch reason as the last line (see fail() in lib.sh).
    var lastLine: String? {
        output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }
    }

    /// What went wrong, in Dutch, for a dialog or the terminal.
    func problem(_ config: AppConfig) -> String {
        if missing {
            return "De projectmap van het Logboek is niet gevonden: \(config.projectDir)\n\nStaat hij nog op dezelfde plek? Installeer de app dan opnieuw met: npm run app:install. Of geef Ash Log toegang tot die map in Systeeminstellingen > Privacy en beveiliging > Bestanden en mappen."
        }
        return lastLine ?? "\(script) stopte met code \(status)."
    }
}

/// Runs one of the scripts in scripts/desktop with /bin/sh, off the main thread.
final class DesktopScript: @unchecked Sendable {
    let name: String
    private let path: String
    // Process is not thread safe: every access that can race goes through the lock.
    private let lock = NSLock()
    private let process = Process()
    private var cancelled = false

    init(_ name: String, config: AppConfig) {
        self.name = name
        path = config.script(name).path
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [path]
        process.currentDirectoryURL = config.projectURL
        process.environment = config.scriptEnvironment(base: ProcessInfo.processInfo.environment)
        process.standardInput = FileHandle.nullDevice
    }

    func run() async -> ScriptResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: self.runAndWait())
            }
        }
    }

    /// Stops the script with SIGTERM. What it already started keeps running (stop.sh deals with that).
    func cancel() {
        lock.lock()
        defer { lock.unlock() }
        cancelled = true
        if process.isRunning { process.terminate() }
    }

    private func runAndWait() -> ScriptResult {
        // Touches the project folder, so macOS may ask for access to Documents here: never on the main thread.
        guard FileManager.default.isReadableFile(atPath: path) else {
            return ScriptResult(script: name, status: 127, output: "", missing: true)
        }
        let pipe = Pipe()
        lock.lock()
        if cancelled {
            lock.unlock()
            return ScriptResult(script: name, status: 143, output: "")
        }
        process.standardOutput = pipe
        process.standardError = pipe
        let launchError: Error?
        do {
            try process.run()
            launchError = nil
        } catch {
            launchError = error
        }
        lock.unlock()
        if let launchError {
            return ScriptResult(script: name, status: 126, output: "\(name) kon niet starten: \(launchError.localizedDescription)")
        }
        // The server the script starts writes to .local/server.log, not to this pipe, so the
        // pipe closes when the script ends.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return ScriptResult(script: name, status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }
}

// MARK: - Quit

/// Stops the server when the app quits, and calls `done` exactly once: when stop.sh has ended,
/// or at the deadline when it hangs (with nil), so a quit or a logout never waits forever.
/// A start.sh that was just cancelled ends first: otherwise stop.sh could run before start.sh
/// wrote the pid of a server it had already launched, and that server would outlive the app.
@MainActor
final class QuitStop {
    private var finished = false
    private let done: @MainActor (ScriptResult?) -> Void

    init(done: @escaping @MainActor (ScriptResult?) -> Void) {
        self.done = done
    }

    func run(_ config: AppConfig, after pendingStart: Task<Void, Never>?, deadline: Duration) {
        Task {
            await pendingStart?.value
            let result = await DesktopScript("stop.sh", config: config).run()
            finish(result)
        }
        Task {
            try? await Task.sleep(for: deadline)
            finish(nil)
        }
    }

    private func finish(_ result: ScriptResult?) {
        guard !finished else { return }
        finished = true
        done(result)
    }
}

// MARK: - Health

/// GET /api/health. Only the app server counts: the dev server (npm run dev) answers there too, with mode "dev".
enum Health {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]  // never through a proxy
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    static func isAppServer(_ config: AppConfig, timeout: TimeInterval) async -> Bool {
        let request = URLRequest(url: config.healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return false }
        return body["mode"] as? String == "app"
    }
}

// MARK: - Look

@MainActor
enum Palette {
    static let ink = NSColor(srgbRed: 0x15 / 255, green: 0x12 / 255, blue: 0x0e / 255, alpha: 1)
    /// The header colour, and the page's theme-color: the titlebar blends into the header.
    static let leather = NSColor(srgbRed: 0x21 / 255, green: 0x1c / 255, blue: 0x16 / 255, alpha: 1)
    static let mutedLight = NSColor(srgbRed: 0xa8 / 255, green: 0x97 / 255, blue: 0x7a / 255, alpha: 1)
}

/// Covers the web view while the server starts: the app's ink colour and one calm line. A
/// native view rather than a page, so there is no white flash and the back gesture never
/// returns to a loading page.
@MainActor
final class LoadingView: NSView {
    private let label = NSTextField(wrappingLabelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Palette.ink.cgColor
        let size: CGFloat = 19
        let serif = NSFont.systemFont(ofSize: size).fontDescriptor.withDesign(.serif)?.withSymbolicTraits(.italic)
        label.font = serif.flatMap { NSFont(descriptor: $0, size: size) } ?? NSFont.systemFont(ofSize: size)
        label.textColor = Palette.mutedLight
        label.alignment = .center
        label.isSelectable = false
        label.preferredMaxLayoutWidth = 520
        label.wantsLayer = true
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -16),
            label.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 32),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func show(_ text: String, pulsing: Bool = true) {
        label.stringValue = text
        label.layer?.removeAllAnimations()
        if pulsing && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.45
            pulse.duration = 1.4
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            label.layer?.add(pulse, forKey: "pulse")
        }
        alphaValue = 1
        isHidden = false
    }

    func hide() {
        guard !isHidden else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2
            self.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                // Shown again while fading: leave it.
                guard let self, self.alphaValue == 0 else { return }
                self.isHidden = true
                self.label.layer?.removeAllAnimations()
            }
        })
    }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSMenuItemValidation {
    /// Keeps the titlebar in step with the page's theme-color.
    private var themeObservation: NSKeyValueObservation?
    private enum Phase {
        case idle
        /// Checking for a running server or running start.sh.
        case starting
        /// The app is loaded and the health checks run.
        case running
        /// A dialog about a problem is up.
        case halted
        /// stop.sh runs; the app quits when it is done.
        case quitting
    }

    private static let startingText = "Ash Log wordt gestart…"
    private static let zoomKey = "AshLogPageZoom"
    private static let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    private static let wikiURL = URL(string: "https://dragonwilds.runescape.wiki")!

    private let configResult: Result<AppConfig, ConfigProblem>
    private var config: AppConfig? { try? configResult.get() }

    private var phase = Phase.idle
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingView: LoadingView!
    private var startScript: DesktopScript?
    private var startTask: Task<Void, Never>?
    private var quitStop: QuitStop?
    private var healthTimer: Timer?
    private var checkingHealth = false
    private var loadAttempts = 0
    /// Bumped on every commit, so a late fallback never hides the overlay of a newer load.
    private var commits = 0
    /// The page to show again after the server restarts.
    private var resumeURL: URL?

    init(config: Result<AppConfig, ConfigProblem>) {
        configResult = config
    }

    // MARK: Life cycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSApp.mainMenu = makeMainMenu()
        makeWindow()
        loadingView.show(Self.startingText)
        window.makeKeyAndOrderFront(nil)
        switch configResult {
        case .success:
            beginStart()
        case .failure(let problem):
            report("Ash Log kan niet starten.", problem.message, withLog: false)
        }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    /// The server keeps running for the phone: closing the window only hides it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if phase != .quitting { showWindow() }
        return false
    }

    /// Cmd-Q, Stop in the Dock, logout and shutdown: stop the server first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if phase == .quitting { return .terminateLater }
        guard let config else { return .terminateNow }
        phase = .quitting
        stopHealthChecks()
        // Quit while still starting: stop start.sh; stop.sh then stops a server it already started.
        startScript?.cancel()
        window?.orderOut(nil)
        // stop.sh itself gives up after about 20 seconds; a logout should not wait that long.
        let stop = QuitStop { result in
            if let result {
                if !result.succeeded { NSLog("Ash Log: stop.sh ended with %d: %@", result.status, result.lastLine ?? "") }
            } else {
                NSLog("Ash Log: stop.sh did not finish within 15 seconds, quitting anyway")
            }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        quitStop = stop
        stop.run(config, after: startTask, deadline: .seconds(15))
        return .terminateLater
    }

    // MARK: Server

    private func beginStart() {
        startTask = Task { await startServer() }
    }

    private func startServer() async {
        guard let config, phase != .quitting else { return }
        phase = .starting
        stopHealthChecks()
        loadingView.show(Self.startingText)

        if await Health.isAppServer(config, timeout: 1) {
            if phase == .starting { serverReady(config) }
            return
        }
        guard phase == .starting else { return }

        let script = DesktopScript("start.sh", config: config)
        startScript = script
        let result = await script.run()
        startScript = nil
        guard phase == .starting else { return }

        if result.succeeded {
            serverReady(config)
        } else {
            // The log is in the project folder: no use offering it when that is out of reach.
            report("Ash Log kan niet starten.", result.problem(config), withLog: !result.missing)
        }
    }

    private func serverReady(_ config: AppConfig) {
        phase = .running
        loadAttempts = 0
        webView.load(URLRequest(url: resumeURL ?? config.appURL))
        resumeURL = nil
        startHealthChecks()
    }

    private func startHealthChecks() {
        healthTimer?.invalidate()
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkHealth() }
        }
        timer.tolerance = 2
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    private func stopHealthChecks() {
        healthTimer?.invalidate()
        healthTimer = nil
    }

    private func checkHealth() {
        guard phase == .running, !checkingHealth, let config else { return }
        checkingHealth = true
        Task {
            defer { checkingHealth = false }
            // One retry, so a busy moment (or just waking from sleep) does not count.
            for attempt in 0..<2 {
                if attempt > 0 { try? await Task.sleep(for: .seconds(1)) }
                guard phase == .running else { return }
                if await Health.isAppServer(config, timeout: 3) { return }
            }
            if phase == .running { serverGone() }
        }
    }

    private func serverGone() {
        phase = .halted
        stopHealthChecks()
        if let url = webView.url, config?.isAppOrigin(url) == true { resumeURL = url }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "De server van Ash Log is gestopt."
        alert.informativeText = "Start hem opnieuw, of stop Ash Log. Wat er gebeurde staat in .local/server.log."
        alert.addButton(withTitle: "Opnieuw starten")
        alert.addButton(withTitle: "Stoppen").keyEquivalent = "\u{1b}"
        present(alert) { [weak self] response in
            guard let self, self.phase == .halted else { return }
            if response == .alertFirstButtonReturn {
                self.beginStart()
            } else {
                NSApp.terminate(nil)
            }
        }
    }

    /// A problem that ends the app. With the log, the first button opens .local/server.log.
    private func report(_ title: String, _ message: String, withLog: Bool) {
        phase = .halted
        loadingView.show("", pulsing: false)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        if withLog { alert.addButton(withTitle: "Log openen") }
        alert.addButton(withTitle: "Stoppen").keyEquivalent = withLog ? "\u{1b}" : "\r"
        present(alert) { [weak self] response in
            if withLog && response == .alertFirstButtonReturn { self?.openLog() }
            NSApp.terminate(nil)
        }
    }

    private func present(_ alert: NSAlert, then handler: @escaping @MainActor (NSApplication.ModalResponse) -> Void) {
        if NSApp.isActive {
            showWindow()
        } else {
            // Do not steal the focus: show the window and bounce the Dock icon once.
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.orderFront(nil)
            NSApp.requestUserAttention(.informationalRequest)
        }
        alert.beginSheetModal(for: window) { response in
            MainActor.assumeIsolated { handler(response) }
        }
    }

    private func openLog() {
        guard let config else { return }
        if !NSWorkspace.shared.open(config.logFile) {
            NSWorkspace.shared.activateFileViewerSelecting([config.logFile.deletingLastPathComponent()])
        }
    }

    // MARK: Window

    private func makeWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Ash Log"
        window.appearance = NSAppearance(named: .darkAqua)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = Palette.leather
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.contentMinSize = NSSize(width: 900, height: 600)
        if let visible = NSScreen.main?.visibleFrame {
            var frame = window.frame
            frame.size.width = min(frame.width, visible.width)
            frame.size.height = min(frame.height, visible.height)
            window.setFrame(frame, display: false)
        }
        window.center()
        // Restores the size and place of the last session, and remembers them from now on.
        window.setFrameAutosaveName("Ash Log")
        window.setFrameUsingName("Ash Log")

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // The transparent titlebar shows the window colour: follow the page's theme-color
        // (index.html), so the titlebar and the app header are one surface.
        themeObservation = webView.observe(\.themeColor, options: [.initial, .new]) { [weak window] webView, _ in
            MainActor.assumeIsolated {
                window?.backgroundColor = webView.themeColor ?? Palette.leather
            }
        }
        webView.underPageBackgroundColor = Palette.ink
        // No white behind the page: while resizing, before the first paint and after a crashed
        // web process the ink of the container shows instead. (KVC reaches WebKit's
        // _setDrawsBackground:, which WKWebView on macOS has had for years; checked first so
        // a WebKit without it only loses this nicety.)
        if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")
        }
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        let zoom = UserDefaults.standard.double(forKey: Self.zoomKey)
        webView.pageZoom = zoom > 0 ? CGFloat(zoom) : 1

        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = Palette.ink.cgColor
        let loadingView = LoadingView()
        for view in [webView, loadingView] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                view.topAnchor.constraint(equalTo: container.topAnchor),
                view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            ])
        }
        window.contentView = container

        self.window = window
        self.webView = webView
        self.loadingView = loadingView
    }

    private func showWindow() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: Web view

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let config else {
            decisionHandler(.allow)
            return
        }
        let route = config.route(
            url,
            subframe: navigationAction.targetFrame.map { !$0.isMainFrame } ?? false,
            download: navigationAction.shouldPerformDownload)
        if route == .window {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            follow(url, route)
        }
    }

    /// A response the web view cannot show (a file to save, for instance) goes to the browser,
    /// instead of failing without a word.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame, !navigationResponse.canShowMIMEType,
              let url = navigationResponse.response.url, let config
        else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        follow(url, config.route(url, download: true))
    }

    /// target=_blank and window.open: the app's own pages load here, everything else opens in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url, let config else { return nil }
        let route = config.route(url, newWindow: true)
        if route == .window {
            webView.load(navigationAction.request)
        } else {
            follow(url, route)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadAttempts = 0
        if phase == .running { loadingView.hide() }
    }

    /// The overlay normally goes at didFinish, which waits for every image on the page. The page
    /// paints ink from its first frame, so a few seconds after the commit it may go anyway: a
    /// request that never ends must not leave the window on "wordt gestart".
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        commits += 1
        let commit = commits
        Task {
            try? await Task.sleep(for: .seconds(4))
            if commit == commits, phase == .running { loadingView.hide() }
        }
    }

    /// The first load after a (re)start can race the server; try a few times before giving up.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        retryFirstLoad(webView, after: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        retryFirstLoad(webView, after: error)
    }

    private func retryFirstLoad(_ webView: WKWebView, after error: any Error) {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
        guard phase == .running, !loadingView.isHidden, let config else { return }
        guard loadAttempts < 3 else {
            loadingView.show("Ash Log laadt niet. Kies Weergave > Herladen om het opnieuw te proberen.", pulsing: false)
            return
        }
        loadAttempts += 1
        let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        Task {
            try? await Task.sleep(for: .seconds(1))
            guard phase == .running else { return }
            webView.load(URLRequest(url: url.flatMap { config.isAppOrigin($0) ? $0 : nil } ?? config.appURL))
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard phase == .running, let config else { return }
        if let url = webView.url, config.isAppOrigin(url) {
            webView.reload()
        } else {
            webView.load(URLRequest(url: config.appURL))
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in
            MainActor.assumeIsolated { completionHandler() }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Annuleer").keyEquivalent = "\u{1b}"
        alert.beginSheetModal(for: window) { response in
            MainActor.assumeIsolated { completionHandler(response == .alertFirstButtonReturn) }
        }
    }

    /// Hands a link the window does not show to the default browser (see AppConfig.route).
    private func follow(_ url: URL, _ route: LinkRoute) {
        if route == .browser {
            NSWorkspace.shared.open(url)
        } else if route == .nowhere {
            NSLog("Ash Log: link not opened: %@", url.absoluteString)
        }
    }

    // MARK: Menu actions

    @objc private func reloadPage(_ sender: Any?) {
        guard phase == .running, let config else { return }
        loadAttempts = 0
        if let url = webView.url, config.isAppOrigin(url) {
            webView.reload()
        } else {
            webView.load(URLRequest(url: config.appURL))
        }
    }

    @objc private func goBack(_ sender: Any?) {
        webView.goBack()
    }

    @objc private func goForward(_ sender: Any?) {
        webView.goForward()
    }

    @objc private func actualSize(_ sender: Any?) {
        setZoom(1)
    }

    @objc private func zoomIn(_ sender: Any?) {
        if let next = Self.zoomSteps.first(where: { $0 > webView.pageZoom + 0.001 }) { setZoom(next) }
    }

    @objc private func zoomOut(_ sender: Any?) {
        if let previous = Self.zoomSteps.last(where: { $0 < webView.pageZoom - 0.001 }) { setZoom(previous) }
    }

    private func setZoom(_ zoom: CGFloat) {
        webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: Self.zoomKey)
    }

    @objc private func openServerLog(_ sender: Any?) {
        openLog()
    }

    @objc private func showAbout(_ sender: Any?) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: paragraph,
        ]
        let credits = NSMutableAttributedString(string: "Spelgegevens van de ", attributes: attributes)
        var link = attributes
        link[.link] = Self.wikiURL
        credits.append(NSAttributedString(string: "RuneScape: Dragonwilds Wiki", attributes: link))
        credits.append(NSAttributedString(string: ", onder CC BY-NC-SA 3.0.", attributes: attributes))
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(reloadPage(_:)):
            return phase == .running
        case #selector(goBack(_:)):
            return phase == .running && webView.canGoBack
        case #selector(goForward(_:)):
            return phase == .running && webView.canGoForward
        case #selector(actualSize(_:)):
            return abs(webView.pageZoom - 1) > 0.001
        case #selector(zoomIn(_:)):
            return webView.pageZoom < (Self.zoomSteps.last ?? 3) - 0.001
        case #selector(zoomOut(_:)):
            return webView.pageZoom > (Self.zoomSteps.first ?? 0.5) + 0.001
        case #selector(openServerLog(_:)):
            return config != nil
        default:
            return true
        }
    }

    // MARK: Menus

    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let app = submenu(of: main, title: "Ash Log")
        add(to: app, "Over Ash Log", #selector(showAbout(_:)), target: self)
        app.addItem(.separator())
        let services = NSMenu(title: "Voorzieningen")
        app.addItem(withTitle: "Voorzieningen", action: nil, keyEquivalent: "").submenu = services
        NSApp.servicesMenu = services
        app.addItem(.separator())
        add(to: app, "Verberg Ash Log", #selector(NSApplication.hide(_:)), "h")
        add(to: app, "Verberg andere", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(to: app, "Toon alle", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        add(to: app, "Stop Ash Log", #selector(NSApplication.terminate(_:)), "q")

        // Needed for Cmd-C, Cmd-V and friends in the web view's text fields.
        let edit = submenu(of: main, title: "Wijzig")
        add(to: edit, "Herstel", Selector(("undo:")), "z")
        add(to: edit, "Opnieuw", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(to: edit, "Knip", #selector(NSText.cut(_:)), "x")
        add(to: edit, "Kopieer", #selector(NSText.copy(_:)), "c")
        add(to: edit, "Plak", #selector(NSText.paste(_:)), "v")
        add(to: edit, "Selecteer alles", #selector(NSText.selectAll(_:)), "a")

        let view = submenu(of: main, title: "Weergave")
        add(to: view, "Terug", #selector(goBack(_:)), "[", target: self)
        add(to: view, "Vooruit", #selector(goForward(_:)), "]", target: self)
        view.addItem(.separator())
        add(to: view, "Herladen", #selector(reloadPage(_:)), "r", target: self)
        view.addItem(.separator())
        add(to: view, "Werkelijke grootte", #selector(actualSize(_:)), "0", target: self)
        add(to: view, "Zoom in", #selector(zoomIn(_:)), "+", target: self)
        // Cmd-= as well, like in Safari, without a second visible item.
        let zoomInEquals = add(to: view, "Zoom in", #selector(zoomIn(_:)), "=", target: self)
        zoomInEquals.isHidden = true
        zoomInEquals.allowsKeyEquivalentWhenHidden = true
        add(to: view, "Zoom uit", #selector(zoomOut(_:)), "-", target: self)
        view.addItem(.separator())
        add(to: view, "Schermvullende weergave", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])

        let windowMenu = submenu(of: main, title: "Venster")
        add(to: windowMenu, "Minimaliseer", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(to: windowMenu, "Zoom", #selector(NSWindow.performZoom(_:)))
        windowMenu.addItem(.separator())
        add(to: windowMenu, "Sluit venster", #selector(NSWindow.performClose(_:)), "w")
        windowMenu.addItem(.separator())
        add(to: windowMenu, "Breng alles naar voren", #selector(NSApplication.arrangeInFront(_:)))
        NSApp.windowsMenu = windowMenu

        let help = submenu(of: main, title: "Help")
        add(to: help, "Serverlog openen", #selector(openServerLog(_:)), target: self)
        NSApp.helpMenu = help

        return main
    }

    private func submenu(of menu: NSMenu, title: String) -> NSMenu {
        let submenu = NSMenu(title: title)
        menu.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = submenu
        return submenu
    }

    @discardableResult
    private func add(
        to menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "",
        _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil
    ) -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }
}

// MARK: - Entry point

// The tests compile this file with -D ASHLOG_SELFTEST and a main of their own
// (scripts/desktop/__fixtures__/SelfTest.swift).
#if !ASHLOG_SELFTEST
@main
enum AshLogApp {
    @MainActor
    static func main() {
        let config = AppConfig.load(from: Bundle.main.infoDictionary ?? [:])
        if let mode = CommandLine.arguments.dropFirst().first(where: Headless.modes.contains) {
            Headless.run(mode, config: config)
        }

        NSWindow.allowsAutomaticWindowTabbing = false
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = AppDelegate(config: config)
        app.delegate = delegate
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
#endif

/// The command line modes: the same configuration, scripts and health check as the window,
/// but no window, no Dock icon and no dialogs. Messages go to stderr, the exit code tells.
enum Headless {
    static let modes = ["--print-config", "--start-server", "--stop-server"]

    @MainActor
    static func run(_ mode: String, config result: Result<AppConfig, ConfigProblem>) -> Never {
        let config: AppConfig
        switch result {
        case .success(let value):
            config = value
        case .failure(let problem):
            fail(problem.message)
        }
        if mode == "--print-config" {
            print(config.json)
            exit(0)
        }
        Task {
            if mode == "--start-server" {
                if await Health.isAppServer(config, timeout: 1) {
                    print("De server draait al op \(config.appURL.absoluteString)")
                    exit(0)
                }
                let started = await DesktopScript("start.sh", config: config).run()
                guard started.succeeded else { fail(started.problem(config)) }
                print("De server draait op \(config.appURL.absoluteString)")
            } else {
                let stopped = await DesktopScript("stop.sh", config: config).run()
                guard stopped.succeeded else { fail(stopped.problem(config)) }
                print("De server is gestopt.")
            }
            exit(0)
        }
        dispatchMain()
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}
