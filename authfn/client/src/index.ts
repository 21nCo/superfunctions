import { createAuthFnHttpClient } from './http-client.js';
import type {
  AuthFnClient,
  AuthFnClientOptions
} from './types.js';

export type * from './types.js';

export function createAuthFnClient(options: AuthFnClientOptions = {}): AuthFnClient {
  const http = createAuthFnHttpClient(options);

  return {
    getSession: () =>
      http.requestJson({
        method: 'GET',
        path: '/session'
      }),
    signUpWithPassword: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/sign-up/password',
        body: input
      }),
    signInWithPassword: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/sign-in/password',
        body: input
      }),
    signOut: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/sign-out',
        body: input ?? {},
        csrf: true
      }),
    listSessions: () =>
      http.requestJson({
        method: 'GET',
        path: '/sessions'
      }),
    revokeSession: (input) =>
      http.requestJson({
        method: 'POST',
        path: `/sessions/${encodeURIComponent(input.sessionId)}/revoke`,
        csrf: true
      }),
    sendOtp: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/otp/send',
        body: input
      }),
    startPasswordReset: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/password/reset/start',
        body: input
      }),
    verifyOtp: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/otp/verify',
        body: input
      }),
    completePasswordReset: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/password/reset/complete',
        body: input
      }),
    startSocialSignIn: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/social/start',
        body: input
      }),
    enableTwoFactor: () =>
      http.requestJson({
        method: 'POST',
        path: '/2fa/enroll',
        csrf: true
      }),
    confirmTwoFactor: (input) =>
      http.requestJson({
        method: 'POST',
        path: '/2fa/confirm',
        body: input,
        csrf: true
      })
  };
}
