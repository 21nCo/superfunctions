@preconcurrency import AVFoundation
import AppKit
import Combine
import CoreGraphics
import Foundation
import RecFnWhisperCpp
import ScreenCaptureKit
import UniformTypeIdentifiers

private struct DesktopProcessResult: Sendable {
    let terminationStatus: Int32
    let standardOutput: Data
    let standardError: Data
}

private enum DesktopProcessRunner {
    static func run(
        executablePath: String,
        arguments: [String]
    ) async -> DesktopProcessResult? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executablePath)
                process.arguments = arguments

                let outputPipe = Pipe()
                let errorPipe = Pipe()
                process.standardOutput = outputPipe
                process.standardError = errorPipe

                do {
                    try process.run()
                    process.waitUntilExit()
                    continuation.resume(
                        returning: DesktopProcessResult(
                            terminationStatus: process.terminationStatus,
                            standardOutput: outputPipe.fileHandleForReading.readDataToEndOfFile(),
                            standardError: errorPipe.fileHandleForReading.readDataToEndOfFile()
                        )
                    )
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}

public enum DesktopMeetingPlatform: String {
    case googleMeet = "Google Meet"
    case zoom = "Zoom"
}

public enum DesktopMeetingPhase: String {
    case candidate = "Candidate"
    case active = "Active"
}

public struct DesktopMeetingCandidate {
    public let platform: DesktopMeetingPlatform
    public let title: String
    public let appName: String
    public let confidence: Double
    public let phase: DesktopMeetingPhase
    public let detail: String
    public let microphoneState: String?

    public var isActiveInCall: Bool {
        phase == .active
    }
}

public struct TranscriptLine: Identifiable {
    public let id = UUID()
    public let timestamp: Date
    public let text: String
    public let isFinal: Bool

    public var formattedTime: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: timestamp)
    }
}

public struct RecFnDesktopLogEntry: Identifiable {
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

public struct MeetingNotes {
    public var summary: String = "Waiting for speech..."
    public var actionItems: [String] = []
    public var decisions: [String] = []
}

@MainActor
public final class RecFnDesktopNotetaker: ObservableObject {
    @Published public var isRunning = false
    @Published public var statusMessage = "Idle"
    @Published public var detectedMeeting: DesktopMeetingCandidate?
    @Published public var transcriptLines: [TranscriptLine] = []
    @Published public var notes = MeetingNotes()
    @Published public var logs: [RecFnDesktopLogEntry] = []

    private var detectionTimer: Timer?
    private var stableCandidateKey: String?
    private var stableCandidateCount = 0
    private var missedMeetingCount = 0
    private var inactiveMeetingCount = 0
    private var capture: DesktopAudioCapture?
    private var finalizedTranscript = ""
    private var currentPartial = ""
    private var lastRecognizedText = ""
    private var missingDetectionHintLogged = false
    private var isStarting = false
    private var isPollingMeeting = false

    public init() {}

    public func start() {
        guard !isRunning, !isStarting else { return }

        isStarting = true
        statusMessage = "Requesting permissions..."
        transcriptLines.removeAll()
        notes = MeetingNotes()
        finalizedTranscript = ""
        currentPartial = ""
        lastRecognizedText = ""
        missingDetectionHintLogged = false
        appendLog("Desktop notetaker started")

        Task { @MainActor [weak self] in
            guard let self else { return }
            let permissionsReady = await requestDesktopSDKPermissions()
            isStarting = false

            guard permissionsReady else {
                isRunning = false
                statusMessage = "Permission required"
                return
            }

            beginMeetingDetection()
        }
    }

    public func stop() {
        guard isRunning else { return }
        appendLog("Stopping desktop notetaker...")
        stopCapture()
        detectionTimer?.invalidate()
        detectionTimer = nil
        detectedMeeting = nil
        stableCandidateKey = nil
        stableCandidateCount = 0
        missedMeetingCount = 0
        inactiveMeetingCount = 0
        isRunning = false
        isStarting = false
        statusMessage = "Desktop notetaker stopped"
        rebuildNotes()
    }

    public func clear() {
        transcriptLines.removeAll()
        notes = MeetingNotes()
        logs.removeAll()
        finalizedTranscript = ""
        currentPartial = ""
        lastRecognizedText = ""
        missingDetectionHintLogged = false
    }

    public func saveTranscript() {
        let lines = transcriptLines.map { line in
            "[\(line.formattedTime)] \(line.text)"
        }
        let notesText = """

        Notes
        Summary:
        \(notes.summary)

        Action Items:
        \(notes.actionItems.isEmpty ? "Nothing yet" : notes.actionItems.map { "- \($0)" }.joined(separator: "\n"))

        Decisions:
        \(notes.decisions.isEmpty ? "Nothing yet" : notes.decisions.map { "- \($0)" }.joined(separator: "\n"))
        """
        let text = (lines + [notesText]).joined(separator: "\n")

        let panel = NSSavePanel()
        panel.title = "Save Meeting Transcript"
        panel.nameFieldStringValue = "meeting-transcript-\(Self.filenameTimestamp()).txt"
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let url = panel.url else { return }

        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            appendLog("Saved transcript to \(url.path)")
        } catch {
            appendLog("Failed to save transcript: \(error.localizedDescription)", isError: true)
        }
    }

    private nonisolated static func filenameTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return formatter.string(from: Date())
    }

    private func beginMeetingDetection() {
        guard !isRunning else { return }

        isRunning = true
        statusMessage = "Looking for meeting..."
        appendLog("Looking for Google Meet or Zoom windows...")

        detectionTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.pollMeeting()
            }
        }
        Task { @MainActor [weak self] in
            await self?.pollMeeting()
        }
    }

    private func requestDesktopSDKPermissions() async -> Bool {
        appendLog("Checking Desktop SDK permissions...")

        let microphoneGranted = await requestMicrophoneAccessIfNeeded()
        if microphoneGranted {
            appendLog("Microphone permission ready")
        } else {
            appendLog(
                "Microphone permission is denied. Enable it in System Settings > Privacy & Security > Microphone.",
                isError: true
            )
        }

        let screenCaptureGranted = requestScreenCaptureAccessIfNeeded()
        if screenCaptureGranted {
            appendLog("Screen & System Audio Recording permission ready")
        } else {
            appendLog(
                "Screen & System Audio Recording was requested but macOS has not reported it as ready yet. Continuing to meeting detection; capture will verify it when audio starts.",
                isError: false
            )
        }

        await requestBrowserAutomationPromptIfPossible()

        return microphoneGranted
    }

    private nonisolated func requestMicrophoneAccessIfNeeded() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }

    private func requestScreenCaptureAccessIfNeeded() -> Bool {
        if CGPreflightScreenCaptureAccess() {
            return true
        }

        appendLog("Requesting Screen & System Audio Recording permission...")
        return CGRequestScreenCaptureAccess()
    }

    private func requestBrowserAutomationPromptIfPossible() async {
        guard let browser = browserScripts.first(where: { isApplicationRunning($0.appName) }) else {
            appendLog("Browser Automation permission will be requested when Chrome/Safari is open.")
            return
        }

        appendLog("Checking browser Automation permission for \(browser.appName)...")
        if !(await browserTabs(for: browser)).isEmpty {
            appendLog("Browser Automation permission ready for \(browser.appName)")
        } else {
            appendLog(
                "Browser Automation permission is not ready. If macOS did not show a prompt, enable this app under System Settings > Privacy & Security > Automation for \(browser.appName).",
                isError: false
            )
        }
    }

    private func pollMeeting() async {
        guard isRunning, !isPollingMeeting else { return }
        isPollingMeeting = true
        defer { isPollingMeeting = false }

        let candidate = await detectMeetingCandidate()
        guard isRunning else { return }

        if let candidate {
            missedMeetingCount = 0
            let key = "\(candidate.platform.rawValue):\(candidate.appName):\(candidate.title):\(candidate.phase.rawValue):\(candidate.detail)"
            if stableCandidateKey == key {
                stableCandidateCount += 1
            } else {
                stableCandidateKey = key
                stableCandidateCount = 1
                appendLog("\(candidate.phase.rawValue) meeting signal: \(candidate.platform.rawValue) - \(candidate.detail)")
            }

            detectedMeeting = candidate
            if candidate.isActiveInCall, stableCandidateCount >= 2, capture == nil {
                inactiveMeetingCount = 0
                startCapture(for: candidate)
            } else if capture == nil, candidate.isActiveInCall {
                statusMessage = "Confirming active \(candidate.platform.rawValue)..."
            } else if capture == nil {
                statusMessage = "Waiting for meeting to start..."
            } else if candidate.isActiveInCall {
                inactiveMeetingCount = 0
                statusMessage = "Listening in \(candidate.platform.rawValue)"
            } else {
                inactiveMeetingCount += 1
                appendLog("Meeting no longer active: \(candidate.detail)")
                if inactiveMeetingCount >= 2 {
                    appendLog("Meeting ended; stopping desktop capture")
                    stopCapture()
                    detectedMeeting = nil
                    stableCandidateKey = nil
                    stableCandidateCount = 0
                    inactiveMeetingCount = 0
                    statusMessage = "Meeting ended"
                }
            }
        } else {
            stableCandidateKey = nil
            stableCandidateCount = 0

            if capture != nil {
                missedMeetingCount += 1
                if missedMeetingCount >= 3 {
                    appendLog("Meeting window disappeared; finalizing notes")
                    stopCapture()
                    detectedMeeting = nil
                    inactiveMeetingCount = 0
                    statusMessage = "Meeting ended"
                }
            } else {
                detectedMeeting = nil
                statusMessage = "Looking for meeting..."
            }
        }
    }

    private func startCapture(for candidate: DesktopMeetingCandidate) {
        statusMessage = "Requesting permissions..."
        let micSuffix = candidate.microphoneState.map { " (mic \($0))" } ?? ""
        appendLog("Meeting detected: \(candidate.platform.rawValue)\(micSuffix)")

        Task {
            let capture = DesktopAudioCapture(
                onStatus: { [weak self] message in
                    Task { @MainActor [weak self] in
                        self?.statusMessage = message
                        self?.appendLog(message)
                    }
                },
                onTranscript: { [weak self] text, isFinal in
                    Task { @MainActor [weak self] in
                        self?.handleTranscript(text, isFinal: isFinal)
                    }
                },
                onError: { [weak self] message in
                    Task { @MainActor [weak self] in
                        self?.statusMessage = "Error: \(message)"
                        self?.appendLog(message, isError: true)
                    }
                }
            )

            self.capture = capture
            do {
                appendLog("Requesting Screen Recording permission...")
                try await capture.start()
                try capture.startTranscription()
                statusMessage = "Listening in \(candidate.platform.rawValue)"
                appendLog("Desktop audio capture started with local whisper.cpp")
            } catch {
                self.capture = nil
                statusMessage = "Capture failed"
                appendLog("Capture failed: \(error.localizedDescription)", isError: true)
            }
        }
    }

    private func stopCapture() {
        capture?.stop()
        capture = nil
        if !currentPartial.isEmpty {
            appendTranscriptLine(currentPartial, isFinal: true)
            finalizedTranscript += " " + currentPartial
            currentPartial = ""
        }
        rebuildNotes()
    }

    private func handleTranscript(_ text: String, isFinal: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let freshText = transcriptDelta(from: trimmed)
        guard !freshText.isEmpty else { return }

        if isFinal {
            appendTranscriptLine(freshText, isFinal: true)
            finalizedTranscript += " " + freshText
            currentPartial = ""
            lastRecognizedText = trimmed
            rebuildNotes()
        } else {
            currentPartial = freshText
            if transcriptLines.last?.isFinal == false {
                transcriptLines.removeLast()
            }
            appendTranscriptLine(freshText, isFinal: false)
        }

        statusMessage = "Transcribing..."
    }

    private func transcriptDelta(from recognizedText: String) -> String {
        guard !lastRecognizedText.isEmpty else { return recognizedText }
        guard recognizedText.hasPrefix(lastRecognizedText) else { return recognizedText }

        return recognizedText
            .dropFirst(lastRecognizedText.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func appendTranscriptLine(_ text: String, isFinal: Bool) {
        transcriptLines.append(TranscriptLine(timestamp: Date(), text: text, isFinal: isFinal))
        if transcriptLines.count > 400 {
            transcriptLines.removeFirst(transcriptLines.count - 400)
        }
    }

    private func rebuildNotes() {
        let text = finalizedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            notes = MeetingNotes()
            return
        }

        let sentences = text
            .replacingOccurrences(of: "\n", with: " ")
            .components(separatedBy: CharacterSet(charactersIn: ".?!"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let summary = sentences.prefix(3).joined(separator: ". ")
        let actionKeywords = ["action", "todo", "to do", "follow up", "need to", "we will", "i will", "please"]
        let decisionKeywords = ["decided", "decision", "agreed", "approved", "we will go with"]

        let actions = sentences.filter { sentence in
            let lower = sentence.lowercased()
            return actionKeywords.contains { lower.contains($0) }
        }

        let decisions = sentences.filter { sentence in
            let lower = sentence.lowercased()
            return decisionKeywords.contains { lower.contains($0) }
        }

        notes = MeetingNotes(
            summary: summary.isEmpty ? text : summary + ".",
            actionItems: Array(actions.prefix(8)),
            decisions: Array(decisions.prefix(8))
        )
    }

    private func detectMeetingCandidate() async -> DesktopMeetingCandidate? {
        if let browserCandidate = await detectBrowserMeetingCandidate() {
            missingDetectionHintLogged = false
            return browserCandidate
        }

        let windows = currentWindows()
        let candidates = windows.compactMap(classifyWindow)
        if let candidate = candidates.sorted(by: { $0.confidence > $1.confidence }).first {
            missingDetectionHintLogged = false
            return candidate
        }

        if !missingDetectionHintLogged, isLikelyBrowserOrMeetingAppOpen(in: windows) {
            missingDetectionHintLogged = true
            appendLog(
                "No meeting title/URL visible yet. If macOS prompts, allow Screen Recording and Automation so the SDK can read the active meeting window.",
                isError: false
            )
        }

        return nil
    }

    private func detectBrowserMeetingCandidate() async -> DesktopMeetingCandidate? {
        var candidates: [DesktopMeetingCandidate] = []
        for browser in browserScripts {
            guard isApplicationRunning(browser.appName) else { continue }
            for tab in await browserTabs(for: browser) {
                let text = "\(tab.title) \(tab.url)"
                if let candidate = classifyBrowserTab(
                    text: text,
                    appName: browser.appName,
                    title: tab.title,
                    tabState: tab.meetingState
                ) {
                    candidates.append(candidate)
                }
            }
        }

        return candidates.sorted {
            if $0.isActiveInCall != $1.isActiveInCall {
                return $0.isActiveInCall && !$1.isActiveInCall
            }
            return $0.confidence > $1.confidence
        }.first
    }

    private func currentWindows() -> [[String: Any]] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard
            let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
        else {
            return []
        }

        return info.filter { window in
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
            return layer == 0 && alpha > 0
        }
    }

    private func classifyWindow(_ window: [String: Any]) -> DesktopMeetingCandidate? {
        let appName = window[kCGWindowOwnerName as String] as? String ?? ""
        let title = window[kCGWindowName as String] as? String ?? ""
        let text = "\(appName) \(title)"
        let lower = text.lowercased()

        if lower.contains("meet.google.com") ||
            lower.contains("google meet") ||
            lower.range(of: #"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b"#, options: .regularExpression) != nil {
            return DesktopMeetingCandidate(
                platform: .googleMeet,
                title: title.isEmpty ? appName : title,
                appName: appName,
                confidence: lower.contains("meet.google.com") ? 0.72 : 0.62,
                phase: .candidate,
                detail: "Meet window visible, waiting for in-call controls",
                microphoneState: nil
            )
        }

        if lower.contains("zoom meeting") ||
            lower.contains("zoom webinar") ||
            appName.lowercased().contains("zoom.us") ||
            appName.lowercased() == "zoom" {
            return DesktopMeetingCandidate(
                platform: .zoom,
                title: title.isEmpty ? appName : title,
                appName: appName,
                confidence: lower.contains("zoom meeting") ? 0.92 : 0.78,
                phase: lower.contains("zoom meeting") ? .active : .candidate,
                detail: lower.contains("zoom meeting") ? "Zoom meeting window active" : "Zoom window visible",
                microphoneState: nil
            )
        }

        return nil
    }

    private func classifyBrowserTab(
        text: String,
        appName: String,
        title: String,
        tabState: BrowserMeetingState?
    ) -> DesktopMeetingCandidate? {
        let lower = text.lowercased()
        if lower.contains("meet.google.com") ||
            lower.contains("google meet") ||
            lower.range(of: #"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b"#, options: .regularExpression) != nil {
            let isActive = tabState?.inCall == true
            let detail = tabState?.detail ?? "Meet URL open, waiting for active call controls"
            return DesktopMeetingCandidate(
                platform: .googleMeet,
                title: title.isEmpty ? "Google Meet" : title,
                appName: appName,
                confidence: isActive ? 0.99 : 0.78,
                phase: isActive ? .active : .candidate,
                detail: detail,
                microphoneState: tabState?.microphoneState
            )
        }

        if lower.contains("zoom.us/j/") ||
            lower.contains("zoom.us/wc/") ||
            lower.contains("zoom meeting") {
            let isActive = tabState?.inCall == true || lower.contains("zoom meeting")
            return DesktopMeetingCandidate(
                platform: .zoom,
                title: title.isEmpty ? "Zoom" : title,
                appName: appName,
                confidence: isActive ? 0.98 : 0.76,
                phase: isActive ? .active : .candidate,
                detail: tabState?.detail ?? (isActive ? "Zoom meeting active" : "Zoom URL open, waiting for call controls"),
                microphoneState: tabState?.microphoneState
            )
        }

        return nil
    }

    private struct BrowserScript {
        let appName: String
        let scriptName: String
    }

    private struct BrowserMeetingState {
        let inCall: Bool
        let microphoneState: String?
        let detail: String
    }

    private struct BrowserTabSnapshot {
        let windowIndex: Int?
        let tabIndex: Int?
        let title: String
        let url: String
        let meetingState: BrowserMeetingState?
    }

    private var browserScripts: [BrowserScript] {
        [
            BrowserScript(appName: "Google Chrome", scriptName: "Google Chrome"),
            BrowserScript(appName: "Chromium", scriptName: "Chromium"),
            BrowserScript(appName: "Brave Browser", scriptName: "Brave Browser"),
            BrowserScript(appName: "Microsoft Edge", scriptName: "Microsoft Edge"),
            BrowserScript(appName: "Safari", scriptName: "Safari"),
        ]
    }

    private func browserTabs(for browser: BrowserScript) async -> [BrowserTabSnapshot] {
        let script: String
        if browser.scriptName == "Safari" {
            script = """
            tell application "\(browser.scriptName)"
                if not (exists front document) then return ""
                set tabTitle to name of front document
                set tabURL to URL of front document
                return tabTitle & linefeed & tabURL
            end tell
            """
        } else {
            script = """
            tell application "\(browser.scriptName)"
                if not (exists front window) then return ""
                set rowSep to ASCII character 30
                set colSep to ASCII character 31
                set outputRows to {}
                repeat with windowIndex from 1 to count of windows
                    repeat with tabIndex from 1 to count of tabs of window windowIndex
                        set tabTitle to title of tab tabIndex of window windowIndex
                        set tabURL to URL of tab tabIndex of window windowIndex
                        set end of outputRows to (windowIndex as text) & colSep & (tabIndex as text) & colSep & tabTitle & colSep & tabURL
                    end repeat
                end repeat
                set AppleScript's text item delimiters to rowSep
                return outputRows as text
            end tell
            """
        }

        guard let output = await runAppleScript(script) else { return [] }

        if browser.scriptName == "Safari" {
            let parts = output.components(separatedBy: .newlines)
            let title = parts.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let url = parts.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty || !url.isEmpty else { return [] }
            return [
                BrowserTabSnapshot(
                    windowIndex: nil,
                    tabIndex: nil,
                    title: title,
                    url: url,
                    meetingState: nil
                )
            ]
        }

        let rowSeparator = String(UnicodeScalar(30)!)
        let columnSeparator = String(UnicodeScalar(31)!)
        let tabRows: [(Int?, Int?, String, String)] = output
            .components(separatedBy: rowSeparator)
            .compactMap { row in
                let parts = row.components(separatedBy: columnSeparator)
                guard parts.count >= 4 else { return nil }
                let windowIndex = Int(parts[0])
                let tabIndex = Int(parts[1])
                let title = parts[2].trimmingCharacters(in: .whitespacesAndNewlines)
                let url = parts.dropFirst(3).joined(separator: columnSeparator)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty || !url.isEmpty else { return nil }
                return (windowIndex, tabIndex, title, url)
            }

        var snapshots: [BrowserTabSnapshot] = []
        for (windowIndex, tabIndex, title, url) in tabRows {
            let meetingState = await inspectMeetingState(
                for: browser,
                url: url,
                windowIndex: windowIndex,
                tabIndex: tabIndex
            )
            snapshots.append(
                BrowserTabSnapshot(
                    windowIndex: windowIndex,
                    tabIndex: tabIndex,
                    title: title,
                    url: url,
                    meetingState: meetingState
                )
            )
        }
        return snapshots
    }

    private func inspectMeetingState(
        for browser: BrowserScript,
        url: String,
        windowIndex: Int?,
        tabIndex: Int?
    ) async -> BrowserMeetingState? {
        guard browser.scriptName != "Safari" else { return nil }

        if url.lowercased().contains("meet.google.com") {
            return await executeMeetingInspectionScript(
                googleMeetInspectionJavaScript,
                for: browser,
                windowIndex: windowIndex,
                tabIndex: tabIndex
            )
        }

        if url.lowercased().contains("zoom.us/") {
            return await executeMeetingInspectionScript(
                zoomInspectionJavaScript,
                for: browser,
                windowIndex: windowIndex,
                tabIndex: tabIndex
            )
        }

        return nil
    }

    private func executeMeetingInspectionScript(
        _ javascript: String,
        for browser: BrowserScript,
        windowIndex: Int?,
        tabIndex: Int?
    ) async -> BrowserMeetingState? {
        guard let windowIndex, let tabIndex else { return nil }
        let escapedJavaScript = javascript
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")

        let script = """
        tell application "\(browser.scriptName)"
            if not (exists window \(windowIndex)) then return ""
            return execute tab \(tabIndex) of window \(windowIndex) javascript "\(escapedJavaScript)"
        end tell
        """

        guard let output = await runAppleScript(script),
              let data = output.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }

        let inCall = object["inCall"] as? Bool ?? false
        let microphoneState = object["mic"] as? String
        let reason = object["reason"] as? String
        let detail = (reason?.isEmpty == false ? reason : nil) ??
            (inCall ? "in-call controls visible" : "waiting for in-call controls")
        return BrowserMeetingState(inCall: inCall, microphoneState: microphoneState, detail: detail)
    }

    private var googleMeetInspectionJavaScript: String {
        """
        (() => {
          const visible = el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const labels = Array.from(document.querySelectorAll('button,[role="button"],[aria-label]'))
            .filter(visible)
            .map(el => ((el.getAttribute('aria-label') || el.innerText || '') + '').toLowerCase().trim())
            .filter(Boolean);
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasJoin = labels.some(x => /join now|ask to join|join meeting|ready to join/.test(x)) || /join now|ask to join|ready to join/.test(bodyText);
          const hasLeave = labels.some(x => /leave call|leave meeting|hang up/.test(x));
          const micOn = labels.some(x => /turn off microphone|mute microphone|microphone is on/.test(x));
          const micOff = labels.some(x => /turn on microphone|unmute microphone|microphone is off/.test(x));
          const hasCallControls = labels.some(x => /turn (on|off) camera|present now|captions|raise hand|more options|people|chat/.test(x));
          const hasInCallText = /present now|raise hand|activities|captions|people|chat|meeting details/.test(bodyText);
          const inCall = hasLeave || (!hasJoin && (micOn || micOff) && (hasCallControls || hasInCallText));
          return JSON.stringify({
            inCall,
            mic: micOn ? 'on' : micOff ? 'off' : 'unknown',
            reason: inCall
              ? (hasLeave ? 'Meet leave/control buttons visible' : 'Meet mic/call controls visible')
              : (hasJoin ? 'Meet pre-join screen visible' : 'Meet tab open, waiting for in-call controls')
          });
        })()
        """
    }

    private var zoomInspectionJavaScript: String {
        """
        (() => {
          const labels = Array.from(document.querySelectorAll('button,[role="button"],[aria-label]'))
            .map(el => ((el.getAttribute('aria-label') || el.innerText || '') + '').toLowerCase().trim())
            .filter(Boolean);
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasJoin = labels.some(x => /join audio|join meeting|launch meeting/.test(x)) || /join audio|launch meeting/.test(bodyText);
          const hasLeave = labels.some(x => /leave|end meeting/.test(x));
          const micOn = labels.some(x => /mute audio|mute microphone/.test(x));
          const micOff = labels.some(x => /unmute audio|unmute microphone/.test(x));
          const hasCallControls = labels.some(x => /share screen|participants|chat|start video|stop video/.test(x));
          const inCall = hasLeave || (!hasJoin && (micOn || micOff || hasCallControls));
          return JSON.stringify({
            inCall,
            mic: micOn ? 'on' : micOff ? 'off' : 'unknown',
            reason: inCall ? 'Zoom call controls visible' : 'Zoom tab open, waiting for call controls'
          });
        })()
        """
    }

    private func runAppleScript(_ source: String) async -> String? {
        guard let result = await DesktopProcessRunner.run(
            executablePath: "/usr/bin/osascript",
            arguments: ["-e", source]
        ) else {
            if !missingDetectionHintLogged {
                appendLog("Browser tab lookup failed: could not launch osascript", isError: false)
            }
            return nil
        }

        let output = String(
            data: result.standardOutput,
            encoding: .utf8
        )?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if result.terminationStatus != 0, !missingDetectionHintLogged {
            let errorOutput = String(
                data: result.standardError,
                encoding: .utf8
            )?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            appendLog(
                "Browser tab lookup unavailable: \(errorOutput ?? "osascript exited \(result.terminationStatus)")",
                isError: false
            )
        }

        return output?.isEmpty == false ? output : nil
    }

    private func isApplicationRunning(_ appName: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains { app in
            app.localizedName == appName || app.bundleIdentifier?.lowercased().contains(appName.lowercased().replacingOccurrences(of: " ", with: "")) == true
        }
    }

    private func isLikelyBrowserOrMeetingAppOpen(in windows: [[String: Any]]) -> Bool {
        let names = windows.compactMap { $0[kCGWindowOwnerName as String] as? String }
        return names.contains { name in
            let lower = name.lowercased()
            return lower.contains("chrome") ||
                lower.contains("safari") ||
                lower.contains("edge") ||
                lower.contains("brave") ||
                lower.contains("zoom")
        }
    }

    private func appendLog(_ text: String, isError: Bool = false) {
        logs.append(RecFnDesktopLogEntry(timestamp: Date(), text: text, isError: isError))
        if logs.count > 300 {
            logs.removeFirst(logs.count - 300)
        }
    }
}

final class DesktopAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let onStatus: @Sendable (String) -> Void
    private let onTranscript: @Sendable (String, Bool) -> Void
    private let onError: @Sendable (String) -> Void

    private let audioQueue = DispatchQueue(label: "MeetingRecordingPOC.desktop-audio")
    private var stream: SCStream?
    private var microphoneEngine: AVAudioEngine?
    private var transcriber: MeetingWhisperTranscriber?
    private var pendingAudioBuffers: [AVAudioPCMBuffer] = []
    private var pendingMicrophoneBuffers: [AVAudioPCMBuffer] = []
    private var lastSystemAudioTime: CFAbsoluteTime = 0
    private let systemEchoGateSeconds: CFTimeInterval = 1.1
    private let systemAudioActiveRMS: Float = 0.006

    init(
        onStatus: @escaping @Sendable (String) -> Void,
        onTranscript: @escaping @Sendable (String, Bool) -> Void,
        onError: @escaping @Sendable (String) -> Void
    ) {
        self.onStatus = onStatus
        self.onTranscript = onTranscript
        self.onError = onError
    }

    func start() async throws {
        onStatus("Checking screen capture access...")
        if !CGPreflightScreenCaptureAccess() {
            onStatus("Waiting for Screen Recording permission...")
            guard CGRequestScreenCaptureAccess() else {
                throw NSError(
                    domain: "DesktopAudioCapture",
                    code: 3,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Screen Recording permission was not granted. Enable it in System Settings > Privacy & Security > Screen & System Audio Recording."
                    ]
                )
            }
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            throw NSError(
                domain: "DesktopAudioCapture",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "No display available for system audio capture"]
            )
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = false
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        self.stream = stream

        onStatus("Starting system audio capture...")
        try await stream.startCapture()
        try startMicrophoneCapture()
    }

    func startTranscription() throws {
        let transcriber = try MeetingWhisperTranscriber(
            onTranscript: onTranscript,
            onStatus: onStatus,
            onError: onError
        )

        audioQueue.sync {
            for buffer in pendingAudioBuffers {
                transcriber.append(buffer, source: .system)
            }
            for buffer in pendingMicrophoneBuffers {
                transcriber.append(buffer, source: .microphone)
            }
            pendingAudioBuffers.removeAll()
            pendingMicrophoneBuffers.removeAll()
            self.transcriber = transcriber
        }

        onStatus("Local whisper.cpp ready")
    }

    func stop() {
        let activeTranscriber = audioQueue.sync {
            let activeTranscriber = transcriber
            transcriber = nil
            return activeTranscriber
        }
        activeTranscriber?.finish()
        stopMicrophoneCapture()

        let currentStream = stream
        stream = nil
        currentStream?.stopCapture { _ in
        }
    }

    func stream(
        _ stream: SCStream,
        didStopWithError error: Error
    ) {
        onError("System audio capture stopped: \(error.localizedDescription)")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio, sampleBuffer.isValid else { return }
        guard let buffer = makePCMBuffer(from: sampleBuffer) else { return }
        if Self.rmsLevel(for: buffer) >= systemAudioActiveRMS {
            lastSystemAudioTime = CFAbsoluteTimeGetCurrent()
        }

        if let transcriber {
            transcriber.append(buffer, source: .system)
        } else if pendingAudioBuffers.count < 50 {
            pendingAudioBuffers.append(buffer)
        }
    }

    private func startMicrophoneCapture() throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        guard status == .authorized else {
            onStatus("Microphone permission is not available; system audio only")
            return
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            onStatus("No microphone input available; system audio only")
            return
        }

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(
            onBus: 0,
            bufferSize: 4096,
            format: inputFormat
        ) { [weak self] buffer, _ in
            self?.handleMicrophoneBuffer(buffer)
        }

        try engine.start()
        microphoneEngine = engine
        onStatus("Microphone capture started")
    }

    private func stopMicrophoneCapture() {
        microphoneEngine?.inputNode.removeTap(onBus: 0)
        microphoneEngine?.stop()
        microphoneEngine = nil
    }

    private func handleMicrophoneBuffer(_ buffer: AVAudioPCMBuffer) {
        audioQueue.async { [weak self] in
            guard let self else { return }
            let isLikelySpeakerEcho =
                CFAbsoluteTimeGetCurrent() - self.lastSystemAudioTime < self.systemEchoGateSeconds
            guard !isLikelySpeakerEcho else { return }

            if let transcriber = self.transcriber {
                transcriber.append(buffer, source: .microphone)
            } else if self.pendingMicrophoneBuffers.count < 50 {
                self.pendingMicrophoneBuffers.append(buffer)
            }
        }
    }

    private func makePCMBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            return nil
        }

        var audioStreamDescription = streamDescription.pointee
        guard let format = AVAudioFormat(streamDescription: &audioStreamDescription) else {
            return nil
        }

        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return nil
        }

        buffer.frameLength = frameCount
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: buffer.mutableAudioBufferList
        )

        return status == noErr ? buffer : nil
    }

    private static func rmsLevel(for buffer: AVAudioPCMBuffer) -> Float {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return 0 }

        var sum = Float.zero
        var count = 0

        if let floatChannelData = buffer.floatChannelData {
            let channelCount = Int(buffer.format.channelCount)
            for channel in 0..<max(channelCount, 1) {
                let channelSamples = floatChannelData[channel]
                for frame in 0..<frameLength {
                    let sample = channelSamples[frame]
                    sum += sample * sample
                    count += 1
                }
            }
        } else if let int16ChannelData = buffer.int16ChannelData {
            let channelCount = Int(buffer.format.channelCount)
            for channel in 0..<max(channelCount, 1) {
                let channelSamples = int16ChannelData[channel]
                for frame in 0..<frameLength {
                    let sample = Float(channelSamples[frame]) / 32768.0
                    sum += sample * sample
                    count += 1
                }
            }
        }

        guard count > 0 else { return 0 }
        return sqrt(sum / Float(count))
    }
}

private enum MeetingAudioSource: String {
    case system = "Them"
    case microphone = "Me"
}

private final class MeetingWhisperTranscriber: @unchecked Sendable {
    private let onTranscript: @Sendable (String, Bool) -> Void
    private let onStatus: @Sendable (String) -> Void
    private let onError: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "MeetingRecordingPOC.whisper.transcription")
    private let wrapper: WhisperCppWrapper
    private let modelURL: URL
    private var systemSamples: [Float] = []
    private var microphoneSamples: [Float] = []
    private var systemSampleRate = 48_000
    private var microphoneSampleRate = 48_000
    private var processingSources: Set<MeetingAudioSource> = []
    private var isStopped = false

    init(
        onTranscript: @escaping @Sendable (String, Bool) -> Void,
        onStatus: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (String) -> Void
    ) throws {
        self.onTranscript = onTranscript
        self.onStatus = onStatus
        self.onError = onError

        let modelURL = try Self.resolveModelURL()
        guard let wrapper = WhisperCppWrapper(modelPath: modelURL.path, coreMLModelPath: nil) else {
            throw NSError(
                domain: "MeetingWhisperTranscriber",
                code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "whisper.cpp could not initialize. Link whisper.xcframework and place a ggml model in ~/Documents/WhisperModels or bundle it with the app."
                ]
            )
        }

        self.modelURL = modelURL
        self.wrapper = wrapper
        onStatus("Using whisper model \(modelURL.lastPathComponent)")
    }

    func append(_ buffer: AVAudioPCMBuffer, source: MeetingAudioSource) {
        let extracted = Self.extractMonoSamples(from: buffer)
        guard !extracted.samples.isEmpty else { return }

        queue.async { [weak self] in
            guard let self, !self.isStopped else { return }
            switch source {
            case .system:
                self.systemSampleRate = extracted.sampleRate
                self.systemSamples.append(contentsOf: extracted.samples)
            case .microphone:
                self.microphoneSampleRate = extracted.sampleRate
                self.microphoneSamples.append(contentsOf: extracted.samples)
            }
            self.trimRollingBuffer(for: source)
            self.processIfReady(source: source, force: false)
        }
    }

    func finish() {
        queue.async { [weak self] in
            guard let self else { return }
            self.isStopped = true
            self.processIfReady(source: .system, force: true)
            self.processIfReady(source: .microphone, force: true)
            self.systemSamples.removeAll()
            self.microphoneSamples.removeAll()
        }
    }

    private func processIfReady(source: MeetingAudioSource, force: Bool) {
        guard !processingSources.contains(source) else { return }

        let sampleRate = sampleRate(for: source)
        let currentSamples = samples(for: source)
        let minimumSamples = Int(Double(sampleRate) * (force ? 0.6 : 2.4))
        guard currentSamples.count >= minimumSamples else { return }

        guard let speechSamples = Self.prepareSamplesForTranscription(currentSamples, sampleRate: sampleRate) else {
            if force {
                clearSamples(for: source)
            } else {
                let keepSamples = Int(Double(sampleRate) * 0.8)
                trimSamples(for: source, keeping: keepSamples)
            }
            return
        }

        let chunkSampleRate = sampleRate
        clearSamples(for: source, keepingCapacity: true)
        processingSources.insert(source)

        do {
            let rawText = try speechSamples.withUnsafeBufferPointer { pointer -> String? in
                guard let baseAddress = pointer.baseAddress else { return nil }
                return try wrapper.transcribeAudio(
                    fromPCMData: baseAddress,
                    sampleCount: Int32(pointer.count),
                    sampleRate: Int32(chunkSampleRate),
                    language: "en",
                    enableDiarization: false,
                    enableTimestamps: false,
                    enableImprovedFormat: true
                )
            }

            let text = Self.sanitizeTranscript(rawText ?? "")
            if !text.isEmpty {
                onTranscript("\(source.rawValue): \(text)", true)
            }
        } catch {
            onError("whisper.cpp \(source.rawValue.lowercased()) transcription error: \(error.localizedDescription)")
        }

        processingSources.remove(source)
    }

    private func samples(for source: MeetingAudioSource) -> [Float] {
        switch source {
        case .system:
            return systemSamples
        case .microphone:
            return microphoneSamples
        }
    }

    private func sampleRate(for source: MeetingAudioSource) -> Int {
        switch source {
        case .system:
            return systemSampleRate
        case .microphone:
            return microphoneSampleRate
        }
    }

    private func clearSamples(for source: MeetingAudioSource, keepingCapacity: Bool = false) {
        switch source {
        case .system:
            systemSamples.removeAll(keepingCapacity: keepingCapacity)
        case .microphone:
            microphoneSamples.removeAll(keepingCapacity: keepingCapacity)
        }
    }

    private func trimSamples(for source: MeetingAudioSource, keeping keepSamples: Int) {
        switch source {
        case .system:
            if systemSamples.count > keepSamples {
                systemSamples.removeFirst(systemSamples.count - keepSamples)
            }
        case .microphone:
            if microphoneSamples.count > keepSamples {
                microphoneSamples.removeFirst(microphoneSamples.count - keepSamples)
            }
        }
    }

    private func trimRollingBuffer(for source: MeetingAudioSource) {
        let sampleRate = sampleRate(for: source)
        let maxSamples = Int(Double(sampleRate) * 8.0)
        switch source {
        case .system:
            if systemSamples.count > maxSamples {
                systemSamples.removeFirst(systemSamples.count - maxSamples)
            }
        case .microphone:
            if microphoneSamples.count > maxSamples {
                microphoneSamples.removeFirst(microphoneSamples.count - maxSamples)
            }
        }
    }

    private static func resolveModelURL() throws -> URL {
        let fileManager = FileManager.default
        let documentDirectory = try fileManager.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )

        let names = [
            "ggml-base.en.bin",
            "ggml-tiny.en.bin",
            "ggml-small.en.bin",
        ]
        let directories = [
            documentDirectory.appendingPathComponent("WhisperModels", isDirectory: true),
            documentDirectory,
        ]

        for directory in directories {
            for name in names {
                let url = directory.appendingPathComponent(name)
                if fileManager.fileExists(atPath: url.path) {
                    return url
                }
            }
        }

        for name in names {
            if let bundled = Bundle.main.url(forResource: name, withExtension: nil) {
                return bundled
            }
        }

        throw NSError(
            domain: "MeetingWhisperTranscriber",
            code: 1,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "No whisper model found. Place ggml-base.en.bin in ~/Documents/WhisperModels or bundle it with the app."
            ]
        )
    }

    private static func extractMonoSamples(from buffer: AVAudioPCMBuffer) -> (samples: [Float], sampleRate: Int) {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return ([], Int(buffer.format.sampleRate)) }

        if let floatChannelData = buffer.floatChannelData {
            let channelCount = Int(buffer.format.channelCount)
            var mono = Array(repeating: Float.zero, count: frameLength)
            for channel in 0..<max(channelCount, 1) {
                let channelSamples = floatChannelData[channel]
                for frame in 0..<frameLength {
                    mono[frame] += channelSamples[frame] / Float(max(channelCount, 1))
                }
            }
            return (mono, Int(buffer.format.sampleRate))
        }

        if let int16ChannelData = buffer.int16ChannelData {
            let channelCount = Int(buffer.format.channelCount)
            var mono = Array(repeating: Float.zero, count: frameLength)
            for channel in 0..<max(channelCount, 1) {
                let channelSamples = int16ChannelData[channel]
                for frame in 0..<frameLength {
                    mono[frame] += Float(channelSamples[frame]) / 32768.0 / Float(max(channelCount, 1))
                }
            }
            return (mono, Int(buffer.format.sampleRate))
        }

        return ([], Int(buffer.format.sampleRate))
    }

    private static func prepareSamplesForTranscription(_ samples: [Float], sampleRate: Int) -> [Float]? {
        guard !samples.isEmpty, sampleRate > 0 else { return nil }

        let rms = sqrt(samples.reduce(Float.zero) { partial, sample in
            partial + (sample * sample)
        } / Float(samples.count))
        guard rms > 0.0035 else { return nil }

        let edgeThreshold: Float = max(0.008, rms * 0.45)
        let paddingSamples = max(Int(Double(sampleRate) * 0.15), 1)

        guard let firstVoice = samples.firstIndex(where: { abs($0) >= edgeThreshold }),
              let lastVoice = samples.lastIndex(where: { abs($0) >= edgeThreshold }) else {
            return nil
        }

        let start = max(0, firstVoice - paddingSamples)
        let end = min(samples.count - 1, lastVoice + paddingSamples)
        guard end >= start else { return nil }

        let trimmed = Array(samples[start...end])
        let minimumSpeechSamples = max(Int(Double(sampleRate) * 0.35), 1)
        return trimmed.count >= minimumSpeechSamples ? trimmed : nil
    }

    private static func sanitizeTranscript(_ text: String) -> String {
        let blankAudioPattern = #"\[(?:BLANK_AUDIO|MUSIC|NOISE|LAUGHTER|APPLAUSE)[^\]]*\]"#
        let stripped = text.replacingOccurrences(
            of: blankAudioPattern,
            with: " ",
            options: .regularExpression
        )
        let collapsedWhitespace = stripped.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        return collapsedWhitespace.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
