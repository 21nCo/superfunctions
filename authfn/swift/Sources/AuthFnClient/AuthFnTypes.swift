import Foundation

public struct AuthFnConfiguration: Sendable {
    public var defaultRegionId: String
    public var resolveBaseURL: @Sendable (String) -> URL
    public var urlSession: URLSession

    public init(
        defaultRegionId: String,
        baseURL: URL,
        urlSession: URLSession = .shared
    ) {
        self.defaultRegionId = defaultRegionId
        self.resolveBaseURL = { _ in baseURL }
        self.urlSession = urlSession
    }

    public init(
        defaultRegionId: String,
        urlSession: URLSession = .shared,
        resolveBaseURL: @escaping @Sendable (String) -> URL
    ) {
        self.defaultRegionId = defaultRegionId
        self.resolveBaseURL = resolveBaseURL
        self.urlSession = urlSession
    }
}

public struct AuthFnRuntime: Codable, Equatable, Sendable {
    public var issuer: String
    public var baseUrl: String
    public var regionId: String?
}

public struct AuthFnRegion: Codable, Equatable, Sendable {
    public var identifier: String
    public var regionId: String
    public var authority: String
    public var domain: String?
    public var continueLocally: Bool
    public var redirectTo: String?
}

public struct AuthFnSession: Codable, Equatable, Sendable {
    public var id: String
    public var actorId: String
    public var regionId: String?
    public var primaryEmail: String?
    public var methods: [String]
}

public struct AuthFnSessionCredential: Codable, Equatable, Sendable {
    public var session: AuthFnSession
    public var token: String
}

public struct AuthFnHandoffStart: Codable, Equatable, Sendable {
    public var code: String
    public var expiresAt: String
    public var consumeUrl: String?
}

public struct AuthFnOAuthCallback: Equatable, Sendable {
    public var code: String?
    public var state: String?
    public var error: String?
}

public enum AuthFnError: Error, Equatable, Sendable {
    case invalidResponse
    case server(code: String, message: String)
    case missingToken
    case unauthenticated
}

struct AuthFnEnvelope<T: Decodable>: Decodable {
    struct EnvelopeError: Decodable {
        var code: String
        var message: String
    }

    var ok: Bool
    var data: T?
    var error: EnvelopeError?
}
