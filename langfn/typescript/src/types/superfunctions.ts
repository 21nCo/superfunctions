declare module "@superfunctions/http" {
  export interface RouteContext {
    params: Record<string, string>;
    query: URLSearchParams;
    url: URL;
    json: <T = unknown>() => Promise<T>;
    formData: () => Promise<FormData>;
    text: () => Promise<string>;
  }

  export type Middleware<TContext = Record<string, unknown>> = (
    request: Request,
    context: TContext & RouteContext,
    next: () => Promise<Response>
  ) => Promise<Response> | Response;

  export interface Route<TContext = Record<string, unknown>> {
    method: string;
    path: string;
    handler: (request: Request, context: TContext & RouteContext) => Promise<Response> | Response;
    middleware?: Array<Middleware<TContext>>;
    meta?: Record<string, unknown>;
  }

  export interface Router<TContext = Record<string, unknown>> {
    handle(request: Request): Promise<Response>;
    getRoutes(): Array<Route<TContext>>;
    addRoute(route: Route<TContext>): void;
    use(middleware: Middleware<TContext>): void;
    match(method: string, path: string): { route: Route<TContext>; params: Record<string, string> } | null;
    handler: (request: Request) => Promise<Response>;
  }

  export function createRouter<TContext = Record<string, unknown>>(options: {
    routes: Array<Route<TContext>>;
    middleware?: Array<Middleware<TContext>>;
    context?: TContext | ((request: Request) => Promise<TContext> | TContext);
    onError?: (error: Error, request: Request) => Response | Promise<Response>;
    basePath?: string;
  }): Router<TContext>;
}

declare module "@superfunctions/auth" {
  export interface AuthSubject {
    actorId: string;
    actorType: string;
    tenantId?: string;
    regionId?: string;
    email?: string;
    attributes?: Record<string, unknown>;
  }

  export interface AuthSession<TMetadata = unknown> {
    id: string;
    type: string;
    subject: AuthSubject;
    resourceIds?: string[];
    scopes?: string[];
    methods?: string[];
    expiresAt?: Date;
    metadata?: TMetadata;
  }

  export interface AuthProvider<TSession extends AuthSession = AuthSession> {
    authenticate(request: Request): Promise<TSession | null>;
    authorize?(session: TSession, resourceId: string): Promise<boolean>;
    revoke?(sessionId: string): Promise<void>;
  }

  export class AuthenticationError extends Error {
    code: string;
    statusCode: number;
    constructor(message?: string);
  }

  export function createAuthMiddleware<TSession extends AuthSession>(
    provider: AuthProvider<TSession>,
    options?: {
      skipPaths?: string[];
      contextKey?: string;
    }
  ): (
    request: Request,
    context: Record<string, unknown>,
    next: () => Promise<Response>
  ) => Promise<Response>;

  export function createBearerAuthMiddleware<TSession>(options: {
    validateToken: (token: string, request: Request) => Promise<TSession | null> | TSession | null;
    contextKey?: string;
    headerName?: string;
    skipPaths?: string[];
  }): (
    request: Request,
    context: Record<string, unknown>,
    next: () => Promise<Response>
  ) => Promise<Response>;
}

declare module "@superfunctions/db" {
  export interface WhereClause {
    field: string;
    operator: string;
    value: unknown;
  }

  export interface Adapter {
    create<T = unknown>(options: { model: string; data: T }): Promise<void>;
    createMany<T = unknown>(options: { model: string; data: T[] }): Promise<void>;
    upsert<T = unknown>(options: {
      model: string;
      where: WhereClause[];
      create: T;
      update: Partial<T>;
    }): Promise<void>;
    delete(options: { model: string; where: WhereClause[] }): Promise<void>;
    findMany<T = unknown>(options: {
      model: string;
      where?: WhereClause[];
      limit?: number;
      offset?: number;
      orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
    }): Promise<T[]>;
    findOne<T = unknown>(options: {
      model: string;
      where?: WhereClause[];
    }): Promise<T | null>;
  }
}

declare module "zod" {
  export namespace z {
    interface ZodType<T = unknown> {
      parse(data: unknown): any;
      optional(): ZodType<any>;
      default(value: unknown): ZodType<any>;
      describe(text: string): ZodType<any>;
    }

    type infer<T> = any;
  }

  export const z: {
    object(shape: Record<string, z.ZodType>): z.ZodType<any>;
    string(): z.ZodType<any>;
    record(value: z.ZodType): z.ZodType<any>;
    any(): z.ZodType<any>;
  };
}

declare module "zod-to-json-schema" {
  export function zodToJsonSchema(schema: unknown): unknown;
}

declare module "node:readline" {
  export interface ReadLineInterface {
    on(event: "line", listener: (line: string) => void): this;
    on(event: "close", listener: () => void): this;
    close(): void;
  }

  const readline: {
    createInterface(options: { input: unknown }): ReadLineInterface;
  };

  export default readline;
}

declare module "node:child_process" {
  export interface ChildProcessWithoutNullStreams {
    stdin: {
      write(chunk: string, callback?: (error?: Error | null) => void): void;
      end?(callback?: () => void): void;
    };
    stdout: unknown;
    kill(signal?: string): void;
    once(event: "exit", listener: () => void): void;
    once(event: "error", listener: (error: Error) => void): void;
  }

  export function spawn(
    command: string,
    args?: string[],
    options?: { env?: Record<string, string>; stdio?: string[] }
  ): ChildProcessWithoutNullStreams;
}
