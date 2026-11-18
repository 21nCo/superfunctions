import Foundation

public struct BillFnClientConfiguration: Sendable {
    public var baseURL: URL
    public var session: URLSession
    /// Headers added to every request `send` makes, read per request so a rotating credential stays current.
    public var headers: @Sendable () async throws -> [String: String]

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        headers: @escaping @Sendable () async throws -> [String: String] = { [:] }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.headers = headers
    }
}

public struct BillFnOperationAction: Codable, Sendable, Equatable {
    public let type: String
    public let url: String?
    public let metadata: [String: String]?

    public init(type: String, url: String? = nil, metadata: [String: String]? = nil) {
        self.type = type
        self.url = url
        self.metadata = metadata
    }
}

public enum BillFnClientError: Error, Equatable {
    case invalidBaseURL
    case invalidResponse
    /// BillFn answered with an error envelope.
    case server(code: String, message: String, status: Int, retryable: Bool)
}

public final class BillFnClient: @unchecked Sendable {
    public let configuration: BillFnClientConfiguration

    public init(configuration: BillFnClientConfiguration) {
        self.configuration = configuration
    }

    public func endpoint(_ path: String) throws -> URL {
        let trimmedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let parts = trimmedPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let pathPart = parts.first.map(String.init) ?? ""
        let queryPart = parts.count > 1 ? String(parts[1]) : nil

        guard var components = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false) else {
            throw BillFnClientError.invalidBaseURL
        }

        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = pathPart.isEmpty ? basePath : "\(basePath)/\(pathPart)"
        if let queryPart {
            var endpointComponents = URLComponents()
            endpointComponents.percentEncodedQuery = queryPart
            components.queryItems = (components.queryItems ?? []) + (endpointComponents.queryItems ?? [])
        }

        guard let url = components.url, url.scheme != nil else {
            throw BillFnClientError.invalidBaseURL
        }
        return url
    }

    public func makeRequest(path: String, method: String = "GET", body: Data? = nil, headers: [String: String]? = nil, accept: String? = nil) throws -> URLRequest {
        var request = URLRequest(url: try endpoint(path))
        request.httpMethod = method
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let accept {
            request.setValue(accept, forHTTPHeaderField: "Accept")
        }
        headers?.forEach { key, value in
            request.setValue(value, forHTTPHeaderField: key)
        }
        return request
    }

    /// Sends a JSON request and returns the `data` of BillFn's success envelope.
    public func send(path: String, method: String = "POST", body: BillFnJSONValue? = nil) async throws -> BillFnJSONValue {
        let encodedBody = try body.map { try JSONEncoder().encode($0) }
        let request = try makeRequest(
            path: path,
            method: method,
            body: encodedBody,
            headers: try await configuration.headers(),
            accept: "application/json"
        )
        let (data, response) = try await configuration.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let envelope: [String: BillFnJSONValue]? = {
            guard case .object(let envelope)? = try? JSONDecoder().decode(BillFnJSONValue.self, from: data) else { return nil }
            return envelope
        }()
        if case .bool(true)? = envelope?["ok"], (200..<300).contains(status), let payload = envelope?["data"] {
            return payload
        }
        // A BillFn rejection names its code and message; an `ok: false` envelope without them is not one, so it is
        // reported below like any other response that is not a BillFn envelope.
        if case .bool(false)? = envelope?["ok"], case .object(let error)? = envelope?["error"],
           let code = error["code"]?.stringValue, !code.isEmpty,
           let message = error["message"]?.stringValue, !message.isEmpty {
            throw BillFnClientError.server(
                code: code,
                message: message,
                status: status,
                retryable: error["retryable"]?.boolValue ?? Self.isRetryable(status: status)
            )
        }
        // No valid BillFn envelope (none at all, a malformed one, or a success-shaped one with an error status): an
        // error status keeps its status, so a timeout, rate limit or 5xx from a gateway or proxy is reported as retryable.
        guard status >= 400 else { throw BillFnClientError.invalidResponse }
        throw BillFnClientError.server(
            code: "BILLFN_HTTP_ERROR",
            message: "BillFn request failed with HTTP \(status)",
            status: status,
            retryable: Self.isRetryable(status: status)
        )
    }

    /// A request timeout, a rate limit or a server error may succeed when retried.
    static func isRetryable(status: Int) -> Bool {
        status == 408 || status == 429 || status >= 500
    }
}
