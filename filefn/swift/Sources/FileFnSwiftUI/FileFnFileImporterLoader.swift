import FileFnClient
import Foundation
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

public enum FileFnFileImporterLoader {
    public static func load(url: URL) async throws -> FileFnImportedAsset {
        guard url.isFileURL else {
            throw FileFnClientError.fileAccess(reason: "Imported file must use a local file URL")
        }

        let normalizedURL = url.standardizedFileURL.resolvingSymlinksInPath()
        let didStartSecurityScope = normalizedURL.startAccessingSecurityScopedResource()
        defer {
            if didStartSecurityScope {
                normalizedURL.stopAccessingSecurityScopedResource()
            }
        }

        let values = try normalizedURL.resourceValues(forKeys: [.isRegularFileKey, .nameKey])
        guard values.isRegularFile == true else {
            throw FileFnClientError.fileAccess(reason: "Imported file URL must reference a readable regular file")
        }

        let data: Data
        do {
            data = try Data(contentsOf: normalizedURL)
        } catch {
            throw FileFnClientError.fileAccess(reason: "Unable to import file from URL: \(error.localizedDescription)")
        }

        let fileName = values.name ?? normalizedURL.lastPathComponent
        let mimeType = fileFnImportedAssetMimeType(
            for: UTType(filenameExtension: normalizedURL.pathExtension),
            fileName: fileName
        )
        let localURL = try fileFnWriteImportedAsset(data: data, fileName: fileName)
        return FileFnImportedAsset(fileURL: localURL, fileName: fileName, mimeType: mimeType)
    }
}
