export type AuthFnActorType = 'user' | 'api-key';
export type AuthFnAuthMethod =
  | 'password'
  | 'email-otp'
  | 'oauth-google'
  | 'oauth-apple'
  | 'oauth-github'
  | 'api-key'
  | 'two-factor';

export interface AuthFnSession {
  id: string;
  type: 'session' | 'api-key';
  subject: {
    actorId: string;
    actorType: AuthFnActorType;
    tenantId?: string;
    regionId?: string;
    email?: string;
    attributes?: Record<string, unknown>;
  };
  actorType: AuthFnActorType;
  actorId: string;
  tenantId?: string;
  regionId?: string;
  resourceIds: string[];
  methods: AuthFnAuthMethod[];
  primaryEmail?: string;
  expiresAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface AuthFnSuccessEnvelope<TData = Record<string, unknown>> {
  ok: true;
  data: TData;
  requestId: string;
}

export interface AuthFnErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

export interface AuthFnSessionEnvelope extends AuthFnSuccessEnvelope<{
  session: AuthFnSession | null;
}> {}

export interface AuthFnListSessionsEnvelope extends AuthFnSuccessEnvelope<{
  sessions: AuthFnSession[];
  currentSessionId?: string;
}> {}

export interface AuthFnOtpEnvelope extends AuthFnSuccessEnvelope<{
  challengeId?: string;
  sent: boolean;
}> {}

export interface AuthFnClient {
  getSession(): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;
  signUpWithPassword(input: {
    email: string;
    password: string;
    profile?: Record<string, unknown>;
  }): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;
  signInWithPassword(input: {
    email: string;
    password: string;
  }): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;
  signOut(input?: { allSessions?: boolean }): Promise<AuthFnSuccessEnvelope<{ revoked: boolean; allSessions: boolean; }> | AuthFnErrorEnvelope>;
  listSessions(): Promise<AuthFnListSessionsEnvelope | AuthFnErrorEnvelope>;
  revokeSession(input: { sessionId: string }): Promise<AuthFnSuccessEnvelope<{ revoked: boolean; sessionId: string; }> | AuthFnErrorEnvelope>;
  sendOtp(input: {
    purpose: 'verify-email' | 'sign-in' | 'reset-password';
    email: string;
  }): Promise<AuthFnOtpEnvelope | AuthFnErrorEnvelope>;
  startPasswordReset(input: {
    email: string;
  }): Promise<AuthFnOtpEnvelope | AuthFnErrorEnvelope>;
  verifyOtp(input: {
    purpose: 'verify-email' | 'sign-in' | 'reset-password';
    email: string;
    code: string;
  }): Promise<AuthFnSessionEnvelope | AuthFnSuccessEnvelope | AuthFnErrorEnvelope>;
  completePasswordReset(input: {
    email: string;
    code: string;
    newPassword: string;
  }): Promise<AuthFnSuccessEnvelope<{ passwordUpdated: true; }> | AuthFnErrorEnvelope>;
  startSocialSignIn(input: {
    provider: 'google' | 'apple' | 'github';
    returnTo?: string;
    callbackMode?: 'redirect' | 'json';
  }): Promise<AuthFnSuccessEnvelope<{
    provider: 'google' | 'apple' | 'github';
    redirectTo: string;
    stateId: string;
    expiresAt: string;
  }> | AuthFnErrorEnvelope>;
  enableTwoFactor(): Promise<AuthFnSuccessEnvelope<{
    enrollmentId: string;
    secret: string;
    otpauthUri: string;
    recoveryCodes: string[];
  }> | AuthFnErrorEnvelope>;
  confirmTwoFactor(input: { code: string }): Promise<AuthFnSuccessEnvelope | AuthFnErrorEnvelope>;
}

export interface AuthFnClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  cookieAccessor?: () => string | undefined;
  credentials?: RequestCredentials;
}
