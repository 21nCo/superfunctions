import Foundation

#if os(iOS)
import AuthenticationServices
import UIKit

public struct AuthFnNativeAppleSignInFailure: Error, Equatable, Sendable {
    public var code: String
    public var message: String?

    public init(code: String, message: String? = nil) {
        self.code = code
        self.message = message
    }
}

public final class AuthFnNativeAppleSignInCoordinator: NSObject {
    public typealias Completion = (Result<AuthFnNativeAppleSignInResult, AuthFnNativeAppleSignInFailure>) -> Void
    public typealias PresentationAnchorProvider = () -> ASPresentationAnchor?

    private let oauthCoordinator = AuthFnOAuthCoordinator()
    private var client: AuthFnClient?
    private var stateId: String?
    private var accountBaseURL: URL?
    private var device: [String: String] = [:]
    private var completion: Completion?
    private var presentationAnchorProvider: PresentationAnchorProvider?
    private var controller: ASAuthorizationController?

    public override init() {}

    public func start(
        client: AuthFnClient,
        accountBaseURL: URL,
        returnTo: String,
        handoffMode: String = "session-token",
        device: [String: String] = [:],
        presentationAnchor: @escaping PresentationAnchorProvider,
        completion: @escaping Completion
    ) {
        self.client = client
        self.accountBaseURL = accountBaseURL
        self.device = device
        self.completion = completion
        self.presentationAnchorProvider = presentationAnchor

        Task {
            do {
                let start = try await client.startNativeAppleSignIn(
                    accountBaseURL: accountBaseURL,
                    returnTo: returnTo,
                    handoffMode: handoffMode
                )
                self.beginAuthorization(stateId: start.stateId, nonce: start.nonce)
            } catch {
                self.finish(.failure(.init(code: "start_failed", message: error.localizedDescription)))
            }
        }
    }

    public func startFromAuthorizeURL(
        _ authorizeURL: URL,
        client: AuthFnClient,
        fallbackAccountBaseURL: URL,
        device: [String: String] = [:],
        presentationAnchor: @escaping PresentationAnchorProvider,
        completion: @escaping Completion
    ) -> Bool {
        guard let context = oauthCoordinator.appleAuthorizeContext(from: authorizeURL) else {
            return false
        }

        self.client = client
        self.accountBaseURL = context.accountBaseURL ?? fallbackAccountBaseURL
        self.device = device
        self.completion = completion
        self.presentationAnchorProvider = presentationAnchor
        beginAuthorization(stateId: context.stateId, nonce: context.nonce)
        return true
    }

    public func cancel() {
        finish(.failure(.init(code: "cancelled")))
    }

    private func beginAuthorization(stateId: String, nonce: String) {
        self.stateId = stateId

        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        controller.performRequests()
    }

    private func finish(_ result: Result<AuthFnNativeAppleSignInResult, AuthFnNativeAppleSignInFailure>) {
        let completion = completion
        DispatchQueue.main.async {
            completion?(result)
        }
        client = nil
        stateId = nil
        accountBaseURL = nil
        device = [:]
        self.completion = nil
        presentationAnchorProvider = nil
        controller = nil
    }
}

extension AuthFnNativeAppleSignInCoordinator: ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        presentationAnchorProvider?() ?? ASPresentationAnchor()
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let identityTokenData = credential.identityToken,
            let identityToken = String(data: identityTokenData, encoding: .utf8),
            let stateId,
            let accountBaseURL,
            let client
        else {
            finish(.failure(.init(code: "missing_identity_token")))
            return
        }

        let authorizationCode = credential.authorizationCode
            .flatMap { String(data: $0, encoding: .utf8) }
        let user = AuthFnNativeAppleUser(
            email: credential.email,
            name: AuthFnNativeAppleUserName(
                firstName: credential.fullName?.givenName,
                lastName: credential.fullName?.familyName
            )
        )
        let hasUserDetails = user.email != nil || user.name?.firstName != nil || user.name?.lastName != nil

        Task {
            do {
                let result = try await client.completeNativeAppleSignIn(
                    accountBaseURL: accountBaseURL,
                    stateId: stateId,
                    identityToken: identityToken,
                    authorizationCode: authorizationCode,
                    user: hasUserDetails ? user : nil,
                    device: device
                )
                self.finish(.success(result))
            } catch {
                self.finish(.failure(.init(code: "complete_failed", message: error.localizedDescription)))
            }
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        finish(.failure(.init(code: "authorization_failed", message: error.localizedDescription)))
    }
}
#endif
