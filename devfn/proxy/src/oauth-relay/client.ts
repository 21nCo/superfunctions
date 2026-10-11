import os from "node:os";
import path from "node:path";

import { readRelayService, registerOAuthRelayState, OAuthRelayError, type RelayStateOptions } from "./state.js";

/** The machine state directory DevFn passes to every process it launches. */
export const STATE_DIR_ENV = "DEVFN_STATE_DIR";

export interface OAuthRelayClientOptions extends RelayStateOptions {
  /**
   * DevFn machine state; defaults to DEVFN_STATE_DIR, which DevFn sets to
   * the lifecycle's own state directory (including --state-dir and
   * XDG_STATE_HOME), then to the CLI's default state directory.
   */
  stateDir?: string;
  /** Opaque lifecycle owner; defaults to DEVFN_INSTANCE_ID. */
  ownerId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface OAuthRelayAuthorization {
  /** The registered redirect URI. Send it unchanged in the authorization request and the token exchange. */
  redirectUri: string;
  expiresAt: string;
}

/**
 * Integration interface for an OAuth client, such as AuthFn, running inside a
 * DevFn lifecycle. It changes no OAuth protocol step: the client still
 * creates and validates its own state, nonce and PKCE verifier, exchanges the
 * code itself and issues its own host-only session. The relay contributes
 * one registered redirect URI and routes each callback, once, to the owner
 * that registered its state.
 */
export class OAuthRelayClient {
  private readonly stateDir: string;
  private readonly ownerId: string;

  public constructor(private readonly options: OAuthRelayClientOptions = {}) {
    const env = options.env ?? process.env;
    this.stateDir = options.stateDir || env[STATE_DIR_ENV] || (env.XDG_STATE_HOME ? path.join(env.XDG_STATE_HOME, "devfn") : path.join(os.homedir(), ".local", "state", "devfn"));
    const ownerId = options.ownerId ?? env.DEVFN_INSTANCE_ID;
    if (!ownerId) throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "No DevFn lifecycle owner is available; run inside devfn up or pass ownerId.");
    this.ownerId = ownerId;
  }

  /** The registered redirect URI for a callback path on the running relay's origin. */
  public async redirectUri(callbackPath: string): Promise<string> {
    const service = await readRelayService(this.stateDir);
    if (!service) throw new OAuthRelayError("DEVFN_OAUTH_RELAY_UNAVAILABLE", "The DevFn OAuth relay is not running; run devfn oauth-relay start.");
    if (!callbackPath.startsWith("/")) throw new OAuthRelayError("DEVFN_OAUTH_RELAY_REJECTED", "A callback path must be absolute.", "malformed");
    return `${service.origin}${callbackPath}`;
  }

  /**
   * Bind the client's freshly generated state to its own callback URL before
   * sending the user to the provider. callbackUrl must be served by one of
   * this owner's live DevFn routes, normally the request's own origin plus
   * the callback path.
   */
  public async authorize(input: { state: string; callbackUrl: string; callbackPath?: string; expiresInSeconds?: number }): Promise<OAuthRelayAuthorization> {
    let callbackPath = input.callbackPath;
    if (callbackPath === undefined) {
      try { callbackPath = new URL(input.callbackUrl).pathname; }
      catch { throw new OAuthRelayError("DEVFN_OAUTH_RELAY_REJECTED", "The callback URL is not a URL.", "malformed"); }
    }
    const redirectUri = await this.redirectUri(callbackPath);
    const { expiresAt } = await registerOAuthRelayState(this.stateDir, {
      ownerId: this.ownerId, state: input.state, redirectUri, callbackUrl: input.callbackUrl,
      ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }),
    }, this.options);
    return { redirectUri, expiresAt };
  }
}
