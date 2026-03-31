@testable import FileFnClient
import Foundation
import Testing

private struct HeaderAuthProvider: FileFnAuthProvider {
    let headersToReturn: [String: String]

    init(_ headersToReturn: [String: String]) {
        self.headersToReturn = headersToReturn
    }

    func headers(for _: FileFnAuthContext) async throws -> [String: String] {
        headersToReturn
    }
}

struct FileFnConfigurationTests {
    @Test
    func relativeBaseURLIsRejected() {
        let configuration = FileFnClientConfiguration(baseURL: URL(string: "/relative")!)

        do {
            _ = try FileFnClient(configuration: configuration)
            Issue.record("Expected configuration validation to fail")
        } catch {
            #expect(
                error as? FileFnClientError ==
                .configurationInvalid(field: "baseURL", message: "baseURL must be an absolute URL")
            )
        }
    }

    @Test
    func requestBuildNormalizesBaseURLAndInjectsHeaders() async throws {
        let configuration = FileFnClientConfiguration(
            baseURL: URL(string: "https://api.example.test/filefn/")!,
            authProvider: HeaderAuthProvider(["Authorization": "Bearer abc"]),
            defaultHeaders: ["x-extra": "1"],
            retryPolicy: .default,
            requestIDProvider: { "req_swift_001" },
            logger: nil,
            sendClientVersionHeader: true
        )

        let client = try FileFnClient(configuration: configuration)
        let request = try await client.makeRequest(
            method: "GET",
            path: "/",
            query: ["limit": "2"],
            requiresUploadSessionToken: false
        )

        #expect(request.url?.absoluteString == "https://api.example.test/filefn/?limit=2")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer abc")
        #expect(request.value(forHTTPHeaderField: "x-extra") == "1")
        #expect(request.value(forHTTPHeaderField: "x-request-id") == "req_swift_001")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "x-filefn-client-version") == "filefn-swift/0.0.1")
    }

    @Test
    func uploadInitRetryRequiresIdempotencyKey() {
        let policy = FileFnRetryPolicy.default
        #expect(policy.shouldRetry(method: "POST", path: "/upload/init", hasIdempotencyKey: false) == false)
        #expect(policy.shouldRetry(method: "POST", path: "/upload/init", hasIdempotencyKey: true) == true)
    }
}
