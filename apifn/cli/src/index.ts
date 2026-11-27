import { cac } from "cac";
import { version } from "../package.json";
import { DEFAULT_CONFIG_PATH, defineConfig, loadConfig } from "./config.js";
import { runInitCommand } from "./commands/init.js";
import { runGenerateCommand } from "./commands/generate.js";
import { runExportCommand } from "./commands/export.js";
import { runValidateCommand } from "./commands/validate.js";
import { runTestCommand } from "./commands/test.js";
import { runImportOpenApiCommand } from "./commands/import.js";
import { runDiffCommand } from "./commands/diff.js";
import { bindConfigCandidates, runCheckCommand } from "./commands/check.js";
import { attachCheckValues, isCheckInvocation, parseCheckArgv } from "./commands/check-args.js";
import { runServeCommand } from "./commands/serve.js";
import { runMockCommand } from "./commands/mock.js";
import { runSnippetCommand } from "./commands/snippet.js";
import { runSdkGenerateCommand } from "./commands/sdk.js";
import { createOutput } from "./utils/output.js";

export { defineConfig, loadConfig };

export interface CliRunOptions {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /**
   * Cancels `apifn check`: an abort before its report reaches stdout rolls back every file it wrote
   * and exits 2. The library installs no process signal listener; the `apifn` binary turns
   * SIGINT, SIGTERM and SIGHUP into this abort while `onPublishing` says files are being written.
   */
  signal?: AbortSignal;
  /** Called with true when `apifn check` starts writing files and with false once they are committed or rolled back. */
  onPublishing?: (publishing: boolean) => void;
}

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

// cac coerces numeric option values and treats some boolean assignments as true.
function readCollectionTrustOptions(argv: string[]): { allowScripts: boolean; allowEnv: string[] } {
  let allowScripts = false;
  const allowEnv: string[] = [];
  for (let index = 0; index < argv.length && argv[index] !== "--"; index += 1) {
    const token = argv[index];
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    // CAC interprets nested keys and accepts negation with any number of dashes.
    const trustFlag = /^(-+)(?:no-)?allow(?:-scripts|-env|Scripts|Env)(\.|$)/.exec(name);
    if (trustFlag && (trustFlag[1] !== "--" || trustFlag[2] === ".")) {
      throw new Error(`Invalid collection trust option '${name}'`);
    } else if (name === "--allow-scripts" || name === "--allowScripts") {
      if (separator >= 0) throw new Error("--allow-scripts takes no value");
      allowScripts = true;
    } else if (name === "--no-allow-scripts" || name === "--no-allowScripts") {
      if (separator >= 0) throw new Error("--no-allow-scripts takes no value");
      allowScripts = false;
    } else if (name === "--allow-env" || name === "--allowEnv") {
      const variableName = separator < 0 ? argv[++index] : token.slice(separator + 1);
      if (!variableName || variableName.startsWith("-") || variableName.includes("=") || variableName.includes("\0")) {
        throw new Error("--allow-env requires an environment variable name");
      }
      allowEnv.push(variableName);
    } else if (name === "--no-allow-env" || name === "--no-allowEnv") {
      throw new Error("--allow-env accepts only explicit environment variable names");
    }
  }
  return { allowScripts, allowEnv };
}

export async function runCli(
  argv = process.argv.slice(2),
  runOptions: CliRunOptions = {}
): Promise<number> {
  let exitCode = 0;

  const cli = cac("apifn");
  const getGlobals = () =>
    (cli.options ?? {}) as {
      config?: string;
      verbose?: boolean;
      quiet?: boolean;
      color?: boolean;
    };

  cli
    .option("--config <path>", `Path to config file (default: ${DEFAULT_CONFIG_PATH})`)
    .option("--verbose", "Enable verbose output")
    .option("--quiet", "Suppress non-error output")
    .option("--no-color", "Disable colored output");

  cli
    .command("init [dir]", "Initialize a new OpenCollection directory")
    .option("--yes", "Skip interactive prompts")
    .option("--force", "Allow initializing into a non-empty directory")
    .action(async (dir: string | undefined, options: { yes?: boolean; force?: boolean }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });

      const result = await runInitCommand({
        dir,
        yes: options.yes,
        force: options.force,
        cwd: runOptions.cwd,
        output,
      });
      if (result !== 0) {
        exitCode = result;
      }
    });

  cli
    .command("generate [routerPath]", "Generate OpenAPI from router")
    .option("--output <path>", "Output file path")
    .action(async (routerPath: string | undefined, options: { output?: string }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });
      const { config } = await loadConfig({
        cwd: runOptions.cwd,
        configPath: globals.config,
      });

      await runGenerateCommand({
        routerPath,
        outputPath: options.output,
        cwd: runOptions.cwd,
        config,
        output,
      });
    });

  cli
    .command("export [format] [output]", "Export generated OpenAPI as yaml/json")
    .option("--input <path>", "Input OpenAPI path")
    .action(async (format: string | undefined, outputPath: string | undefined, options: { input?: string }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });
      const { config } = await loadConfig({
        cwd: runOptions.cwd,
        configPath: globals.config,
      });

      const normalized = format === "json" ? "json" : "yaml";
      await runExportCommand({
        format: normalized,
        outputPath,
        inputPath: options.input,
        cwd: runOptions.cwd,
        config,
        output,
      });
    });

  cli
    .command("import <kind> <source>", "Import an OpenAPI document as an OpenCollection")
    .option("--output <dir>", "Output collection directory")
    .option("--base-url <url>", "Base URL for generated environment")
    .option("--env <name>", "Environment name to create (default: development)")
    .option("--group-by <mode>", "Group requests by tag | path (default: tag)")
    .option("--force", "Allow writing into a non-empty output directory")
    .action(
      async (
        kind: string,
        source: string,
        options: {
          output?: string;
          baseUrl?: string;
          env?: string;
          groupBy?: string;
          force?: boolean;
        }
      ) => {
        const globals = getGlobals();
        const output = createOutput({
          quiet: globals.quiet,
          verbose: globals.verbose,
          color: globals.color !== false,
          writeStdout: runOptions.stdout,
          writeStderr: runOptions.stderr,
        });

        if (kind !== "openapi") {
          output.error(`Unsupported import kind '${kind}'. Supported: openapi.`);
          exitCode = 2;
          return;
        }

        const groupBy = options.groupBy === "path" ? "path" : "tag";
        const result = await runImportOpenApiCommand({
          source,
          outputDir: options.output ?? ".",
          baseUrl: options.baseUrl,
          env: options.env,
          groupBy,
          force: options.force,
          cwd: runOptions.cwd,
          output,
        });
        if (result !== 0) {
          exitCode = result;
        }
      }
    );

  cli
    .command("test [collectionDir]", "Run a collection's tests")
    .option("--env <name>", "Environment name to use")
    .option("--bail", "Stop on first failure")
    .option("--parallel", "Run requests in parallel")
    .option("--concurrency <n>", "Max concurrent requests (parallel mode)")
    .option("--timeout <ms>", "Per-request timeout in milliseconds")
    .option("--include <pattern>", "Only run requests matching path/name pattern")
    .option("--exclude <pattern>", "Skip requests matching path/name pattern")
    .option("--retries <n>", "Retry failed requests")
    .option("--delay <ms>", "Delay between sequential requests in milliseconds")
    .option("--env-var <keyValue>", "Override an environment variable (KEY=value)")
    .option("--allow-env <name>", "Expose a named process environment variable to the collection")
    .option("--allow-scripts", "Execute scripts in a trusted collection")
    .option("--dotenv <path>", "Load dotenv file as environment overrides")
    .option("--redact-header <name>", "Additional response/request header to redact")
    .option("--output <path>", "Write machine-readable report artifact")
    .option("--reporter <type>", "Reporter type: console | json | junit | silent (default: console)")
    .action(
      async (
        collectionDir: string | undefined,
        options: {
          env?: string;
          bail?: boolean;
          parallel?: boolean;
          concurrency?: string;
          timeout?: string;
          include?: string | string[];
          exclude?: string | string[];
          retries?: string;
          delay?: string;
          envVar?: string | string[];
          dotenv?: string;
          redactHeader?: string | string[];
          output?: string;
          reporter?: string;
        }
      ) => {
        const globals = getGlobals();
        const output = createOutput({
          quiet: globals.quiet,
          verbose: globals.verbose,
          color: globals.color !== false,
          writeStdout: runOptions.stdout,
          writeStderr: runOptions.stderr,
        });

        const reporterValue = options.reporter;
        const validReporters = ["console", "json", "junit", "silent"] as const;
        type R = (typeof validReporters)[number];
        const reporter: R = validReporters.includes(reporterValue as R)
          ? (reporterValue as R)
          : "console";

        const trailing = cli.options["--"] as string[];
        if (cli.args.length + trailing.length > 1) {
          throw new Error("apifn test takes at most one collection directory");
        }
        const result = await runTestCommand({
          ...trustOptions,
          collectionDir: collectionDir ?? trailing[0],
          env: options.env,
          bail: options.bail,
          parallel: options.parallel,
          concurrency: options.concurrency ? Number(options.concurrency) : undefined,
          timeout: options.timeout ? Number(options.timeout) : undefined,
          include: toArray(options.include),
          exclude: toArray(options.exclude),
          retries: options.retries ? Number(options.retries) : undefined,
          delay: options.delay ? Number(options.delay) : undefined,
          envVar: toArray(options.envVar),
          dotenv: options.dotenv,
          redactHeader: toArray(options.redactHeader),
          outputPath: options.output,
          reporter,
          color: globals.color !== false,
          cwd: runOptions.cwd,
          output,
          writeStdout: runOptions.stdout,
        });
        if (result !== 0) {
          exitCode = result;
        }
      }
    );

  cli
    .command("diff <before> <after>", "Compare two OpenAPI specs for breaking changes")
    .option("--format <type>", "Output format: text | json (default: text)")
    .option("--fail-on-breaking", "Exit 1 on breaking changes (default: true)", { default: true })
    .action(
      async (
        before: string,
        after: string,
        options: { format?: string; failOnBreaking?: boolean }
      ) => {
        const globals = getGlobals();
        const output = createOutput({
          quiet: globals.quiet,
          verbose: globals.verbose,
          color: globals.color !== false,
          writeStdout: runOptions.stdout,
          writeStderr: runOptions.stderr,
        });

        const formatValue = options.format === "json" ? "json" : "text";
        const result = await runDiffCommand({
          before,
          after,
          format: formatValue,
          failOnBreaking: options.failOnBreaking !== false,
          cwd: runOptions.cwd,
          output,
          writeStdout: runOptions.stdout,
        });
        if (result !== 0) {
          exitCode = result;
        }
      }
    );

  cli
    .command(
      "check [routerPath]",
      "Regenerate the spec, fail on drift, validate it and block unversioned breaking changes"
    )
    .option("--spec <path>", "Committed spec (default: <config.output or .apifn>/openapi.yml)")
    .option("--base <ref>", "Git ref whose committed spec is the base")
    .option("--base-spec <pathOrUrl>", "Base spec file path or HTTP(S) URL")
    .option("--allow-breaking", "Report breaking changes without failing")
    .option("--write", "Rewrite a drifted spec instead of failing")
    .option("--format <type>", "Report format: text | json | markdown (default: text)")
    .option("--report <path>", "Also write the report to this file")
    // The options above are declared for help and for cac's own parse errors; the action reads
    // the arguments itself (see check-args.ts), so cac's coercions and dropped arguments never
    // reach the check.
    .action(async () => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });

      let args;
      let config;
      let configFile: string | undefined;
      let configRead;
      try {
        const { configPath, ...checkArgs } = parseCheckArgv(argv);
        args = checkArgs;
        // Bound before loading: a config file changed after the load fails the check (exit 2).
        const candidates = bindConfigCandidates(runOptions.cwd, configPath);
        ({ config, path: configFile } = await loadConfig({ cwd: runOptions.cwd, configPath }));
        // loadConfig returns the candidate path it loaded, as bindConfigCandidates resolved it.
        configRead = configFile === undefined ? undefined : candidates.get(configFile);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        exitCode = 2;
        return;
      }

      const result = await runCheckCommand({
        ...args,
        cwd: runOptions.cwd,
        config,
        configFile,
        configRead,
        output,
        writeStdout: runOptions.stdout,
        signal: runOptions.signal,
        onPublishing: runOptions.onPublishing,
      });
      if (result !== 0) exitCode = result;
    });

  cli
    .command("serve [specPath]", "Serve interactive API explorer")
    .option("--port <port>", "Port to bind (default: 4100)")
    .option("--open", "Open browser automatically")
    .action(async (specPath: string | undefined, options: { port?: string; open?: boolean }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });
      const result = await runServeCommand({
        specPath,
        port: options.port ? parseInt(options.port, 10) : undefined,
        open: options.open ?? false,
        cwd: runOptions.cwd,
        output,
      });
      if (result !== 0) exitCode = result;
    });

  cli
    .command("mock <specPath>", "Start mock server from OpenAPI spec")
    .option("--mode <mode>", "Response mode: schema | examples | random (default: schema)")
    .option("--port <port>", "Port to bind (default: 4010)")
    .option("--validate-requests", "Validate incoming request bodies")
    .option("--delay <ms>", "Add delay to responses (ms)")
    .action(async (specPath: string, options: { mode?: string; port?: string; validateRequests?: boolean; delay?: string }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });
      const mode = ["schema", "examples", "random"].includes(options.mode ?? "")
        ? (options.mode as "schema" | "examples" | "random")
        : "schema";
      const result = await runMockCommand({
        specPath,
        mode,
        port: options.port ? parseInt(options.port, 10) : undefined,
        validateRequests: options.validateRequests ?? false,
        delay: options.delay ? parseInt(options.delay, 10) : undefined,
        cwd: runOptions.cwd,
        output,
      });
      if (result !== 0) exitCode = result;
    });

  cli
    .command("snippet <specPath> [apiPath]", "Generate code snippet for an endpoint")
    .option("--target <target>", "Snippet target (curl, fetch, axios, …) (default: curl)")
    .option("--method <method>", "HTTP method (default: get)")
    .option("--base-url <url>", "Base URL override")
    .option("--all", "Generate snippets for all endpoints")
    .action(async (specPath: string, apiPath: string | undefined, options: { target?: string; method?: string; baseUrl?: string; all?: boolean }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });
      const result = await runSnippetCommand({
        specPath,
        apiPath,
        target: options.target,
        method: options.method,
        baseUrl: options.baseUrl,
        all: options.all ?? false,
        cwd: runOptions.cwd,
        output,
        writeStdout: runOptions.stdout,
      });
      if (result !== 0) exitCode = result;
    });

  cli
    .command("sdk <action>", "Generate an SDK package from an operation catalog (action: generate)")
    .option("--sdk-config <path>", "SDK config JSON: { target, unsupported?, options }")
    .option("--catalog <path>", "Operation catalog JSON built by @apifn/contracts")
    .option("--spec <path>", "OpenAPI document to build the catalog from (with --manifest)")
    .option("--manifest <path>", "Companion manifest for --spec")
    .option("--out <dir>", "Package directory to write")
    .option("--check", "Write nothing; exit 1 if the package directory is out of date")
    .option("--format <type>", "Output format: text | json (default: text)")
    .action(
      async (
        action: string,
        options: { sdkConfig?: string; catalog?: string; spec?: string; manifest?: string; out?: string; check?: boolean; format?: string }
      ) => {
        const globals = getGlobals();
        const output = createOutput({
          quiet: globals.quiet,
          verbose: globals.verbose,
          color: globals.color !== false,
          writeStdout: runOptions.stdout,
          writeStderr: runOptions.stderr,
        });
        if (action !== "generate") {
          output.error(`Unknown sdk action '${action}'. Supported: generate.`);
          exitCode = 2;
          return;
        }
        const result = await runSdkGenerateCommand({
          configPath: options.sdkConfig,
          catalogPath: options.catalog,
          specPath: options.spec,
          manifestPath: options.manifest,
          outDir: options.out,
          check: options.check ?? false,
          format: options.format === "json" ? "json" : "text",
          cwd: runOptions.cwd,
          output,
          writeStdout: runOptions.stdout,
        });
        if (result !== 0) exitCode = result;
      }
    );

  cli
    .command("validate <specPath>", "Validate OpenAPI document")
    .option("--format <type>", "Output format: text | json (default: text)")
    .action(async (specPath: string, options: { format?: string }) => {
      const globals = getGlobals();
      const output = createOutput({
        quiet: globals.quiet,
        verbose: globals.verbose,
        color: globals.color !== false,
        writeStdout: runOptions.stdout,
        writeStderr: runOptions.stderr,
      });

      const result = await runValidateCommand({
        specPath,
        format: options.format === "json" ? "json" : "text",
        cwd: runOptions.cwd,
        output,
        writeStdout: runOptions.stdout,
      });
      if (result !== 0) {
        exitCode = result;
      }
    });

  cli.help();
  cli.version(version);

  let trustOptions: ReturnType<typeof readCollectionTrustOptions>;
  try {
    trustOptions = readCollectionTrustOptions(argv);
  } catch (error) {
    createOutput({ writeStdout: runOptions.stdout, writeStderr: runOptions.stderr, color: false }).error(
      error instanceof Error ? error.message : String(error)
    );
    return 2;
  }

  // `apifn check` reads its own arguments first: cac would print help (exit 0) for a malformed
  // check invocation that also names --help, instead of the usage error (exit 2).
  const separator = argv.indexOf("--");
  // Give cac an explicit boolean value so it leaves the following path untouched.
  let cacArgv = argv.map((arg, index) =>
    (separator < 0 || index < separator) && (arg === "--allow-scripts" || arg === "--allowScripts")
      ? "--allowScripts=true"
      : arg
  );
  if (isCheckInvocation(argv)) {
    try {
      parseCheckArgv(argv);
      cacArgv = attachCheckValues(argv);
    } catch (error) {
      createOutput({ writeStdout: runOptions.stdout, writeStderr: runOptions.stderr, color: false }).error(
        error instanceof Error ? error.message : String(error)
      );
      return 2;
    }
  }

  try {
    cli.parse(["node", "apifn", ...cacArgv], { run: false });
    await cli.runMatchedCommand();
  } catch (error) {
    const usageExit = cli.matchedCommandName === "check" || cli.matchedCommandName === "test" ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    const output = createOutput({
      writeStdout: runOptions.stdout,
      writeStderr: runOptions.stderr,
      color: false,
    });
    output.error(message);
    return usageExit;
  }

  return exitCode;
}
