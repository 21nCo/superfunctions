import AppKit
import Combine
import Foundation

public enum RecFnBotEventType: String, Decodable {
    case status, joined, recording, error, ended
}

public struct RecFnBotEvent: Decodable {
    public let type: RecFnBotEventType
    public let message: String?
    public let platform: String?
    public let url: String?
    public let path: String?
    public let reason: String?
}

public struct RecFnBotLogEntry: Identifiable {
    public let id = UUID()
    public let timestamp: Date
    public let text: String
    public let isError: Bool

    public var formattedTime: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: timestamp)
    }
}

@MainActor
public final class RecFnMeetingBotController: ObservableObject {
    @Published public var isRunning = false
    @Published public var statusMessage = "Idle"
    @Published public var logs: [RecFnBotLogEntry] = []
    @Published public var recordingPath: String?
    @Published public var joinedPlatform: String?
    @Published public var detectedMeetingURL: String?

    private var process: Process?
    private var setupLoginProcess: Process?

    public init() {}

    public func start(
        url: String?,
        displayName: String,
        platform: String,
        recordingDir: String,
        runtimeDirectory: String? = nil
    ) {
        guard !isRunning else { return }

        let explicitURL = url?.trimmingCharacters(in: .whitespacesAndNewlines)
        let meetingURL = explicitURL?.isEmpty == false ? explicitURL! : (detectActiveMeetingURL() ?? "")
        guard !meetingURL.isEmpty else {
            statusMessage = "Error: no active meeting found"
            appendLog("No active Google Meet or Zoom tab found. Join the meeting first, or paste a meeting URL.", isError: true)
            return
        }

        detectedMeetingURL = meetingURL
        let resolvedPlatform = platform == "auto" ? detectPlatform(url: meetingURL) : platform
        closeBotLoginProfileIfRunning()

        guard let nodePath = findNodePath() else {
            appendLog("Node.js not found. Install it from https://nodejs.org or Homebrew.", isError: true)
            statusMessage = "Error: Node.js not found"
            return
        }

        let botRuntimeDir = resolveBotRuntimeDirectory(preferred: runtimeDirectory)
        guard FileManager.default.fileExists(atPath: botRuntimeDir + "/src/index.ts") else {
            appendLog("Bot runtime src/index.ts not found at: \(botRuntimeDir)", isError: true)
            statusMessage = "Error: bot runtime not found"
            return
        }

        let tsxPackagePath = botRuntimeDir + "/node_modules/tsx"
        guard FileManager.default.fileExists(atPath: tsxPackagePath) else {
            appendLog("tsx not found. Run `pnpm install` inside the bot runtime.", isError: true)
            statusMessage = "Error: bot runtime dependencies missing"
            return
        }

        var args: [String] = ["--import", "tsx", "src/index.ts", meetingURL]
        if !displayName.isEmpty { args += ["--name=\(displayName)"] }
        if resolvedPlatform != "auto" { args += ["--platform=\(resolvedPlatform)"] }
        if !recordingDir.isEmpty { args += ["--recording-dir=\(recordingDir)"] }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = args
        process.currentDirectoryURL = URL(fileURLWithPath: botRuntimeDir)
        process.environment = enrichedEnvironment(nodePath: nodePath)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in self?.handleBotOutput(text) }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            for line in text.components(separatedBy: .newlines).filter({ !$0.isEmpty }) {
                Task { @MainActor [weak self] in self?.appendLog("[stderr] \(line)", isError: true) }
            }
        }

        process.terminationHandler = { [weak self] proc in
            Task { @MainActor [weak self] in
                self?.isRunning = false
                self?.statusMessage = "Bot stopped (exit \(proc.terminationStatus))"
                self?.appendLog("Process exited with status \(proc.terminationStatus)")
                self?.process = nil
            }
        }

        do {
            try process.run()
            self.process = process
            isRunning = true
            statusMessage = "Sending bot..."
            appendLog("Detected meeting URL: \(meetingURL)")
            appendLog("Bot process started (PID \(process.processIdentifier))")
            appendLog("Command: \(nodePath) \(args.joined(separator: " "))")
        } catch {
            statusMessage = "Failed to start bot: \(error.localizedDescription)"
            appendLog("Launch error: \(error.localizedDescription)", isError: true)
        }
    }

    public func stop() {
        guard let process, process.isRunning else { return }
        process.interrupt()
        appendLog("Sent SIGINT to bot process...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if let proc = self?.process, proc.isRunning {
                proc.terminate()
                self?.appendLog("Sent SIGTERM (forced stop)")
            }
        }
    }

    public func openBotLoginProfile(runtimeDirectory: String? = nil) {
        guard let chromePath = findChromePath() else {
            appendLog("Google Chrome not found. Install Chrome before setting up bot login.", isError: true)
            statusMessage = "Error: Chrome not found"
            return
        }

        let profileDir = botProfileDirectory()
        do {
            try FileManager.default.createDirectory(
                atPath: profileDir,
                withIntermediateDirectories: true
            )
        } catch {
            appendLog("Could not create bot profile directory: \(error.localizedDescription)", isError: true)
            statusMessage = "Error: profile setup failed"
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: chromePath)
        process.arguments = [
            "--user-data-dir=\(profileDir)",
            "--no-first-run",
            "--new-window",
            "https://accounts.google.com",
        ]

        do {
            try process.run()
            setupLoginProcess = process
            statusMessage = "Bot login window opened"
            appendLog("Opened Chrome with bot profile: \(profileDir)")
            appendLog("Sign in with the dedicated bot Google account, then close that Chrome window.")
        } catch {
            statusMessage = "Error: bot login failed"
            appendLog("Could not open Chrome bot profile: \(error.localizedDescription)", isError: true)
        }
    }

    public func clearLogs() {
        logs.removeAll()
    }

    private func handleBotOutput(_ raw: String) {
        for line in raw.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            parseEvent(trimmed)
            appendLog(trimmed)
        }
    }

    private func parseEvent(_ line: String) {
        guard
            let data = line.data(using: .utf8),
            let event = try? JSONDecoder().decode(RecFnBotEvent.self, from: data)
        else { return }

        switch event.type {
        case .status:
            statusMessage = event.message ?? statusMessage
        case .joined:
            joinedPlatform = event.platform
            statusMessage = "Live in \(event.platform ?? "meeting")"
        case .recording:
            recordingPath = event.path
            if let path = event.path {
                statusMessage = "Recording -> \(URL(fileURLWithPath: path).lastPathComponent)"
            }
        case .error:
            statusMessage = "Error: \(event.message ?? "unknown")"
        case .ended:
            statusMessage = "Meeting ended (\(event.reason ?? "unknown reason"))"
            isRunning = false
        }
    }

    private func appendLog(_ text: String, isError: Bool = false) {
        logs.append(RecFnBotLogEntry(timestamp: Date(), text: text, isError: isError))
        if logs.count > 500 {
            logs.removeFirst(logs.count - 500)
        }
    }

    private func detectActiveMeetingURL() -> String? {
        let browserNames = ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge"]
        for browserName in browserNames {
            guard isApplicationRunning(browserName) else { continue }
            if let url = browserMeetingURLs(for: browserName).first {
                return url
            }
        }
        return safariMeetingURL()
    }

    private func browserMeetingURLs(for browserName: String) -> [String] {
        let script = """
        tell application "\(browserName)"
            if not (exists front window) then return ""
            set rowSep to ASCII character 30
            set outputRows to {}
            repeat with windowIndex from 1 to count of windows
                repeat with tabIndex from 1 to count of tabs of window windowIndex
                    set tabURL to URL of tab tabIndex of window windowIndex
                    if tabURL contains "meet.google.com/" or tabURL contains "zoom.us/" then
                        set end of outputRows to tabURL
                    end if
                end repeat
            end repeat
            set AppleScript's text item delimiters to rowSep
            return outputRows as text
        end tell
        """
        guard let output = runAppleScript(script) else { return [] }
        let rowSeparator = String(UnicodeScalar(30)!)
        return output
            .components(separatedBy: rowSeparator)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func safariMeetingURL() -> String? {
        let script = """
        tell application "Safari"
            if not (exists front document) then return ""
            set tabURL to URL of front document
            if tabURL contains "meet.google.com/" or tabURL contains "zoom.us/" then
                return tabURL
            end if
            return ""
        end tell
        """
        return runAppleScript(script)
    }

    private func runAppleScript(_ source: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]
        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        let output = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return output?.isEmpty == false ? output : nil
    }

    private func detectPlatform(url: String) -> String {
        if url.contains("meet.google.com") { return "google-meet" }
        if url.contains("zoom.us") { return "zoom" }
        return "auto"
    }

    private func findNodePath() -> String? {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        if let fromWhich = shellOutput("/usr/bin/which", ["node"]) {
            let path = fromWhich.trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty && FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    private func findChromePath() -> String? {
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ].first { FileManager.default.fileExists(atPath: $0) }
    }

    private func botProfileDirectory() -> String {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first?.path ?? (NSHomeDirectory() + "/Library/Application Support")

        return URL(fileURLWithPath: appSupport)
            .appendingPathComponent("MeetingRecordingPOC")
            .appendingPathComponent("google-meet-bot-profile")
            .path
    }

    private func resolveBotRuntimeDirectory(preferred: String?) -> String {
        let bundleResourcePath = Bundle.main.resourceURL?
            .appendingPathComponent("BotRuntime")
            .path

        let candidates = [
            preferred,
            bundleResourcePath,
            "/Volumes/T7/21n/poc/ios/MeetingRecordingPOC/BotRuntime",
            NSHomeDirectory() + "/21n/poc/ios/MeetingRecordingPOC/BotRuntime",
            NSHomeDirectory() + "/Developer/21n/poc/ios/MeetingRecordingPOC/BotRuntime",
        ].compactMap { $0 }

        return candidates.first {
            FileManager.default.fileExists(atPath: $0 + "/src/index.ts")
        } ?? (preferred ?? candidates.first ?? "")
    }

    private func enrichedEnvironment(nodePath: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            URL(fileURLWithPath: nodePath).deletingLastPathComponent().path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]
        let existing = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = (extraPaths + [existing]).joined(separator: ":")
        return env
    }

    private func shellOutput(_ executable: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
        } catch {
            return nil
        }
    }

    private func isApplicationRunning(_ appName: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains { app in
            app.localizedName == appName ||
                app.bundleIdentifier?.lowercased().contains(appName.lowercased().replacingOccurrences(of: " ", with: "")) == true
        }
    }

    private func closeBotLoginProfileIfRunning() {
        if let process = setupLoginProcess, process.isRunning {
            appendLog("Closing bot login Chrome window before starting bot...")
            process.terminate()
            process.waitUntilExit()
        }
        setupLoginProcess = nil

        let profileDir = botProfileDirectory()
        let pkill = Process()
        pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        pkill.arguments = ["-TERM", "-f", "user-data-dir=\(profileDir)"]
        pkill.standardOutput = Pipe()
        pkill.standardError = Pipe()

        do {
            try pkill.run()
            pkill.waitUntilExit()
            if pkill.terminationStatus == 0 {
                appendLog("Closed existing Chrome process using the bot profile.")
                Thread.sleep(forTimeInterval: 0.5)
            }
        } catch {
            // Best-effort cleanup only.
        }
    }
}
