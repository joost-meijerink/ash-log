// Test driver for native/AshLog.swift, compiled only by build-app.test.ts, together with the
// app's source and -D ASHLOG_SELFTEST (which leaves out the app's own @main). It runs the
// parts of the app that need no window:
//
//   SelfTest routes <port>
//       stdin: JSON [{ url, subframe?, newWindow?, download? }]
//       stdout: JSON [route], the AppConfig.route of each (window, browser or nowhere)
//
//   SelfTest quit <project> <deadline in seconds> [pending-start]
//       Runs QuitStop the way the app does on quit, against <project>/scripts/desktop/stop.sh.
//       With pending-start, start.sh runs first and is cancelled just before, as when you quit
//       while the app is still starting. Waits until well past the deadline, then prints
//       JSON { calls: [{ status, lastLine, missing, ms }] }: one entry per call of `done`
//       (status null when the deadline answered).
import Foundation

@MainActor
final class Calls {
    var list: [[String: Any]] = []
}

@main
@MainActor
enum SelfTest {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        switch args.first {
        case "routes" where args.count == 2:
            routes(port: Int(args[1]) ?? 0)
        case "quit" where args.count >= 3:
            await quit(project: args[1], deadline: Double(args[2]) ?? 1, pendingStart: args.dropFirst(3).contains("pending-start"))
        default:
            FileHandle.standardError.write(Data("usage: SelfTest routes <port> | quit <project> <deadline> [pending-start]\n".utf8))
            exit(2)
        }
        exit(0)
    }

    struct RouteCase: Decodable {
        let url: String
        var subframe: Bool?
        var newWindow: Bool?
        var download: Bool?
    }

    static func routes(port: Int) {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let cases = try? JSONDecoder().decode([RouteCase].self, from: input) else {
            FileHandle.standardError.write(Data("bad input\n".utf8))
            exit(2)
        }
        let config = AppConfig(projectDir: "/", nodePath: "/usr/bin/true", port: port)
        let routes = cases.map { item -> String in
            guard let url = URL(string: item.url) else { return "invalid" }
            return config.route(url, subframe: item.subframe ?? false, newWindow: item.newWindow ?? false, download: item.download ?? false).rawValue
        }
        print(String(decoding: (try? JSONSerialization.data(withJSONObject: routes)) ?? Data(), as: UTF8.self))
    }

    static func quit(project: String, deadline: Double, pendingStart: Bool) async {
        let config = AppConfig(projectDir: project, nodePath: "/usr/bin/true", port: 1)
        var pending: Task<Void, Never>?
        if pendingStart {
            let start = DesktopScript("start.sh", config: config)
            pending = Task { _ = await start.run() }
            try? await Task.sleep(for: .milliseconds(400))
            start.cancel()
        }
        let began = ContinuousClock.now
        let calls = Calls()
        let stop = QuitStop { result in
            let elapsed = ContinuousClock.now - began
            var entry: [String: Any] = [
                "ms": Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000),
                "status": NSNull(), "lastLine": NSNull(), "missing": NSNull(),
            ]
            if let result {
                entry["status"] = Int(result.status)
                entry["lastLine"] = result.lastLine.map { $0 as Any } ?? NSNull()
                entry["missing"] = result.missing
            }
            calls.list.append(entry)
        }
        let deadlineMs = Int(deadline * 1000)
        stop.run(config, after: pending, deadline: .milliseconds(deadlineMs))
        // Well past the deadline and a quick script, so a second call would show up.
        try? await Task.sleep(for: .milliseconds(deadlineMs + 800))
        let data = (try? JSONSerialization.data(withJSONObject: ["calls": calls.list])) ?? Data()
        print(String(decoding: data, as: UTF8.self))
    }
}
