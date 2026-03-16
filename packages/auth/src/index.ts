/**
 * @superfunctions/auth - Framework-agnostic authentication abstraction layer
 */

// Core types
export type {
  AuthSession,
  AuthProvider,
  AuthProviderConfig,
  AuthContext,
  AuthContextProvider,
} from './types.js';

// Errors
export {
  AuthError,
  AuthenticationError,
  AuthorizationError,
  InvalidCredentialsError,
  ExpiredCredentialsError,
} from './types.js';

// Middleware utilities
export {
  createAuthMiddleware,
  createResourceAuthMiddleware,
  createBearerAuthMiddleware,
  extractBearerToken,
  extractBearerTokenFromHeader,
} from './middleware.js';
