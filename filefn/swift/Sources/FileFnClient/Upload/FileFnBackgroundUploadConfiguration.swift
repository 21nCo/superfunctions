import Foundation

public struct FileFnBackgroundUploadConfiguration: @unchecked Sendable {
    public var workingDirectory: URL
    public var stateStore: any FileFnUploadStateStore
    public var secretStore: any FileFnSecretStore

    public init(
        workingDirectory: URL? = nil,
        stateStore: (any FileFnUploadStateStore)? = nil,
        secretStore: (any FileFnSecretStore)? = nil
    ) {
        let resolvedWorkingDirectory = workingDirectory ?? Self.defaultWorkingDirectory()
        self.workingDirectory = resolvedWorkingDirectory
        self.stateStore = stateStore ?? FileFnFileSystemUploadStateStore(rootDirectory: resolvedWorkingDirectory)
        self.secretStore = secretStore ?? FileFnKeychainSecretStore(serviceName: "org.21n.filefn.swift")
    }

    static func defaultWorkingDirectory() -> URL {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let baseDirectory = applicationSupport ?? FileManager.default.temporaryDirectory
        return baseDirectory
            .appendingPathComponent("filefn", isDirectory: true)
            .appendingPathComponent("background-uploads", isDirectory: true)
    }
}
