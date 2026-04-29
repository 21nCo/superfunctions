import AppKit
import Foundation

public struct RecFnHostedBotConfig {
    public var serverURL: String
    public var apiKey: String

    public init(serverURL: String, apiKey: String) {
        self.serverURL = serverURL
        self.apiKey = apiKey
    }
}

private struct HostedCreateBotRequest: Encodable {
    let meetingUrl: String
    let platform: String?
    let config: HostedBotRuntimeConfig
}

private struct HostedBotRuntimeConfig: Encodable {
    let displayName: String
    let recordingFormat: String
    let language: String
}

private struct HostedEnvelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: HostedEnvelopeError?
}

private struct HostedEnvelopeError: Decodable {
    let code: String
    let message: String
}

private struct HostedBot: Decodable {
    let id: String
    let meetingUrl: String
    let platform: String
    let status: String
    let errorMessage: String?
    let recordings: [HostedRecording]?
}

private struct HostedRecording: Decodable {
    let id: String
    let downloadUrl: String?
    let storageRef: String
}

@MainActor
public final class RecFnHostedBotController: ObservableObject {
    @Published public var isRunning = false
    @Published public var statusMessage = "Idle"
    @Published public var logs: [RecFnBotLogEntry] = []
    @Published public var recordingPath: String?
    @Published public var joinedPlatform: String?
    @Published public var detectedMeetingURL: String?
    @Published public var botId: String?

    private var pollTask: Task<Void, Never>?
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func start(
        url: String?,
        displayName: String,
        platform: String,
        recordingDir: String,
        hosted: RecFnHostedBotConfig
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
        statusMessage = "Sending bot..."
        appendLog("Detected meeting URL: \(meetingURL)")
        appendLog("Calling hosted RecFn bot API: \(hosted.serverURL)")

        Task {
            do {
                let bot = try await createHostedBot(
                    meetingURL: meetingURL,
                    displayName: displayName.isEmpty ? "Recording Bot" : displayName,
                    platform: platform,
                    hosted: hosted
                )
                botId = bot.id
                joinedPlatform = bot.platform
                isRunning = true
                apply(bot)
                startPolling(hosted: hosted, botId: bot.id)
            } catch {
                isRunning = false
                statusMessage = "Error: \(error.localizedDescription)"
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    public func stop(hosted: RecFnHostedBotConfig) {
        guard let botId else { return }
        statusMessage = "Stopping bot..."
        appendLog("Requesting hosted bot leave: \(botId)")
        Task {
            do {
                _ = try await request(
                    path: "/api/v1/bots/\(botId)/leave",
                    method: "POST",
                    hosted: hosted,
                    body: Optional<Int>.none
                ) as HostedEnvelope<HostedBot>
            } catch {
                appendLog("Leave request failed: \(error.localizedDescription)", isError: true)
            }
        }
    }

    public func clearLogs() {
        logs.removeAll()
    }

    private func createHostedBot(
        meetingURL: String,
        displayName: String,
        platform: String,
        hosted: RecFnHostedBotConfig
    ) async throws -> HostedBot {
        let mappedPlatform = mapPlatform(platform)
        let body = HostedCreateBotRequest(
            meetingUrl: meetingURL,
            platform: mappedPlatform,
            config: HostedBotRuntimeConfig(
                displayName: displayName,
                recordingFormat: "audio_only",
                language: "en-US"
            )
        )
        let envelope: HostedEnvelope<HostedBot> = try await request(
            path: "/api/v1/bots",
            method: "POST",
            hosted: hosted,
            body: body
        )
        guard envelope.ok, let bot = envelope.data else {
            throw NSError(
                domain: "RecFnHostedBot",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: envelope.error?.message ?? "Hosted bot create failed"]
            )
        }
        return bot
    }

    private func pollHostedBot(hosted: RecFnHostedBotConfig, botId: String) async throws -> HostedBot {
        let envelope: HostedEnvelope<HostedBot> = try await request(
            path: "/api/v1/bots/\(botId)",
            method: "GET",
            hosted: hosted,
            body: Optional<Int>.none
        )
        guard envelope.ok, let bot = envelope.data else {
            throw NSError(
                domain: "RecFnHostedBot",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: envelope.error?.message ?? "Hosted bot poll failed"]
            )
        }
        return bot
    }

    private func startPolling(hosted: RecFnHostedBotConfig, botId: String) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                    let bot = try await self?.pollHostedBot(hosted: hosted, botId: botId)
                    if let bot {
                        await MainActor.run { self?.apply(bot) }
                    }
                    if let status = bot?.status, ["done", "left", "error"].contains(status) {
                        break
                    }
                } catch {
                    await MainActor.run {
                        self?.appendLog("Poll failed: \(error.localizedDescription)", isError: true)
                    }
                }
            }
        }
    }

    private func apply(_ bot: HostedBot) {
        let previous = statusMessage
        statusMessage = bot.status
        joinedPlatform = bot.platform
        if previous != bot.status {
            appendLog("Hosted bot \(bot.id) status: \(bot.status)")
        }
        if let errorMessage = bot.errorMessage, !errorMessage.isEmpty {
            appendLog(errorMessage, isError: true)
        }
        if let recording = bot.recordings?.last {
            recordingPath = recording.downloadUrl ?? recording.storageRef
        }
        if ["done", "left", "error"].contains(bot.status) {
            isRunning = false
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private func request<T: Encodable, U: Decodable>(
        path: String,
        method: String,
        hosted: RecFnHostedBotConfig,
        body: T?
    ) async throws -> U {
        let base = hosted.serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: base + normalizedPath) else {
            throw NSError(domain: "RecFnHostedBot", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid hosted bot server URL"])
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(hosted.apiKey)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(status)"
            throw NSError(domain: "RecFnHostedBot", code: status, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONDecoder().decode(U.self, from: data)
    }

    private func mapPlatform(_ platform: String) -> String? {
        switch platform {
        case "google-meet": return "meet"
        case "zoom": return "zoom"
        default: return nil
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
        return nil
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

    private func isApplicationRunning(_ appName: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains { app in
            app.localizedName == appName ||
                app.bundleIdentifier?.lowercased().contains(appName.lowercased().replacingOccurrences(of: " ", with: "")) == true
        }
    }
}
