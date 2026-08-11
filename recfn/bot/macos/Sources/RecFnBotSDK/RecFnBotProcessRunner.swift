import Foundation

struct RecFnBotProcessResult: Sendable {
    let terminationStatus: Int32
    let standardOutput: Data
    let standardError: Data
}

enum RecFnBotProcessRunner {
    static func run(
        executablePath: String,
        arguments: [String]
    ) async -> RecFnBotProcessResult? {
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
                        returning: RecFnBotProcessResult(
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
