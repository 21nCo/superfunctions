import Foundation

public struct FileFnPreparedUpload: Sendable {
    public let fileURL: URL
    public let fileName: String
    public let mimeType: String
    public let metadata: [String: FileFnJSONValue]?
    public let fileSize: Int64

    public init(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        metadata: [String: FileFnJSONValue]? = nil,
        fileSize: Int64
    ) {
        self.fileURL = fileURL
        self.fileName = fileName
        self.mimeType = mimeType
        self.metadata = metadata
        self.fileSize = fileSize
    }

    public func replacing(
        fileURL: URL? = nil,
        fileName: String? = nil,
        mimeType: String? = nil,
        metadata: [String: FileFnJSONValue]?? = nil,
        fileSize: Int64? = nil
    ) -> FileFnPreparedUpload {
        FileFnPreparedUpload(
            fileURL: fileURL ?? self.fileURL,
            fileName: fileName ?? self.fileName,
            mimeType: mimeType ?? self.mimeType,
            metadata: metadata ?? self.metadata,
            fileSize: fileSize ?? self.fileSize
        )
    }
}

public protocol FileFnUploadPreprocessor: Sendable {
    func prepare(_ upload: FileFnPreparedUpload) async throws -> FileFnPreparedUpload
}

struct FileFnPreparedUploadHandle: Sendable {
    let upload: FileFnPreparedUpload
    private let cleanupURLs: [URL]

    init(upload: FileFnPreparedUpload, cleanupURLs: [URL]) {
        self.upload = upload
        self.cleanupURLs = cleanupURLs
    }

    func cleanup() {
        for url in cleanupURLs {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

enum FileFnUploadPreparation {
    static func prepare(
        request: FileFnForegroundUploadRequest,
        defaultPreprocessors: [any FileFnUploadPreprocessor]
    ) async throws -> FileFnPreparedUploadHandle {
        let materialized = try FileFnTemporaryFileMaterializer.materialize(
            source: request.source,
            preferredFileName: request.fileName
        )
        var cleanupURLs: [URL] = materialized.isTemporary ? [materialized.fileURL] : []
        var prepared = FileFnPreparedUpload(
            fileURL: materialized.fileURL,
            fileName: materialized.fileName,
            mimeType: fileFnInferMimeType(
                requestedMimeType: request.mimeType,
                fileName: materialized.fileName
            ),
            metadata: request.metadata,
            fileSize: materialized.fileSize
        )

        let preprocessors = request.preprocessors ?? defaultPreprocessors
        for preprocessor in preprocessors {
            let next = try await preprocessor.prepare(prepared)
            try validatePreparedUpload(next)
            if next.fileURL != prepared.fileURL, !cleanupURLs.contains(next.fileURL) {
                cleanupURLs.append(next.fileURL)
            }
            prepared = next
        }

        return FileFnPreparedUploadHandle(upload: prepared, cleanupURLs: cleanupURLs)
    }

    private static func validatePreparedUpload(_ upload: FileFnPreparedUpload) throws {
        let values = try upload.fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else {
            throw FileFnClientError.fileAccess(reason: "Prepared upload source must be a regular file")
        }
    }
}
