import Foundation

public struct AuthFnOAuthCoordinator: Sendable {
    public init() {}

    public func parseCallbackURL(_ url: URL) throws -> AuthFnOAuthCallback {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw AuthFnError.invalidResponse
        }

        let queryItems = components.queryItems ?? []
        return AuthFnOAuthCallback(
            code: queryItems.first(where: { $0.name == "code" })?.value,
            state: queryItems.first(where: { $0.name == "state" })?.value,
            error: queryItems.first(where: { $0.name == "error" })?.value
        )
    }
}
