import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSuperfunctionsPackages } from "../utils/discover-packages.js";
import { discoverLibraryConfigs } from "../utils/discover-configs.js";
import { loadLibraryConfig } from "../utils/load-library-config.js";
import { CliSchemaGenerationError, generateLibraryAbstractSchema } from "../utils/schema-generators.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("authfn scoped schema discovery", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(__dirname, `authfn-discovery-${Date.now()}`);
    fs.mkdirSync(path.join(testDir, "node_modules", "@authfn", "core"), {
      recursive: true,
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("discovers @authfn/core and generates schema from plugin-rich config", async () => {
    fs.writeFileSync(
      path.join(testDir, "node_modules", "@authfn", "core", "package.json"),
      JSON.stringify({
        name: "@authfn/core",
        superfunctions: {
          initFunction: "createAuthFn",
          schemaVersion: 1,
          libraryNames: ["authfn"],
        },
      })
    );

    const configPath = path.join(testDir, "authfn.config.ts");
    fs.writeFileSync(
      configPath,
      `
      export default () => ({
        namespace: 'auth',
        plugins: ['password', 'emailOtp', 'socialOAuth'],
      });
      `
    );

    const discoveredPackages = discoverSuperfunctionsPackages(testDir);
    expect(discoveredPackages).toContainEqual(
      expect.objectContaining({
        packageName: "@authfn/core",
        libraryNames: ["authfn"],
      })
    );

    const discoveredConfigs = await discoverLibraryConfigs(testDir);
    expect(discoveredConfigs).toEqual([
      expect.objectContaining({
        libraryName: "authfn",
        packageName: "@authfn/core",
        configPath,
      }),
    ]);

    const loadedConfig = await loadLibraryConfig(configPath);
    expect(loadedConfig).toEqual({
      namespace: "auth",
      plugins: ["password", "emailOtp", "socialOAuth"],
    });

    const schema = await generateLibraryAbstractSchema(
      {
        getSchema: async (config: { plugins: string[] }) => ({
          version: 1,
          schemas: [
            {
              modelName: "users",
              fields: {
                email: { type: "string", required: true },
                id: { type: "string", required: true },
              },
            },
            {
              modelName: "sessions",
              fields: {
                expiresAt: { type: "date", required: true },
                id: { type: "string", required: true },
              },
            },
            ...(config.plugins.includes("password")
              ? [
                  {
                    modelName: "password_credentials",
                    fields: {
                      passwordHash: { type: "string", required: true },
                      userId: { type: "string", required: true },
                    },
                  },
                ]
              : []),
            ...(config.plugins.includes("emailOtp")
              ? [
                  {
                    modelName: "otp_challenges",
                    fields: {
                      expiresAt: { type: "date", required: true },
                      codeHash: { type: "string", required: true },
                    },
                  },
                ]
              : []),
            ...(config.plugins.includes("socialOAuth")
              ? [
                  {
                    modelName: "oauth_accounts",
                    fields: {
                      providerId: { type: "string", required: true },
                      userId: { type: "string", required: true },
                    },
                  },
                ]
              : []),
          ],
        }),
      },
      loadedConfig
    );

    expect(schema.schemas.map((table) => table.modelName)).toEqual([
      "users",
      "sessions",
      "password_credentials",
      "otp_challenges",
      "oauth_accounts",
    ]);
    expect(Object.keys(schema.schemas[0].fields)).toEqual(["email", "id"]);
  });

  it("fails with a structured CLI error when getSchema is missing", async () => {
    await expect(generateLibraryAbstractSchema({}, { namespace: "auth" })).rejects.toMatchObject<
      Partial<CliSchemaGenerationError>
    >({
      code: "CLI_SCHEMA_GENERATION_ERROR",
      details: {
        reason: "missing-get-schema",
      },
    });
  });
});
