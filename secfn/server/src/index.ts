import { createStaticKeyProvider, getSecFnSchema } from "@secfn/core";
import type { KeyProvider, SecurityScanner } from "@secfn/core";
import { createSecurityScanner } from "@secfn/core";
import { SecFnConfigError } from "@secfn/core";
import { AuditService } from "./audit.js";
import { AccessService } from "./access.js";
import { SecFnRateLimiter } from "./rate-limit.js";
import { createSecFnRouter } from "./router.js";
import type { SecFnRequestContext, SecFnServerConfig } from "./types.js";
import { VaultService } from "./vault.js";

export type * from "./types.js";
export { AuditService, createSecurityLoggerSink } from "./audit.js";
export { AccessService, matchesPermission } from "./access.js";
export { SecFnRateLimiter } from "./rate-limit.js";
export { VaultService } from "./vault.js";
export { createSecFnRouter } from "./router.js";

export interface SecFnServer<TContext extends SecFnRequestContext = SecFnRequestContext> {
  router: ReturnType<typeof createSecFnRouter<TContext>>;
  vault: VaultService;
  access: AccessService;
  rateLimit: SecFnRateLimiter;
  audit: AuditService;
  scanner: SecurityScanner;
  getSchema(): ReturnType<typeof getSecFnSchema>;
}

export function createSecFnServer<TContext extends SecFnRequestContext = SecFnRequestContext>(
  config: SecFnServerConfig<TContext>,
): SecFnServer<TContext> {
  const keyProvider = resolveKeyProvider(config);
  const audit = new AuditService({
    db: config.db,
    logger: config.logger,
    sink: config.auditSink,
  });
  const access = new AccessService(config.db);
  const vault = new VaultService(config.db, keyProvider, audit);
  const rateLimit = new SecFnRateLimiter(config.rateLimit, audit);
  const scanner = createSecurityScanner();
  const router = createSecFnRouter(config, {
    vault,
    audit,
    access,
    rateLimit,
  });

  return {
    router,
    vault,
    access,
    rateLimit,
    audit,
    scanner,
    getSchema: getSecFnSchema,
  };
}

function resolveKeyProvider<TContext extends SecFnRequestContext>(
  config: SecFnServerConfig<TContext>,
): KeyProvider {
  if (config.keyProvider) return config.keyProvider;
  if (config.encryption?.masterKey) {
    return createStaticKeyProvider(
      config.encryption.masterKey,
      config.encryption.keyId ?? "default",
    );
  }
  throw new SecFnConfigError("SecFn server requires keyProvider or encryption.masterKey");
}

export { getSecFnSchema, getSchema } from "@secfn/core";
