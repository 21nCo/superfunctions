/**
 * The bare `superfunctions` package runs this CLI with BARE_EXPECTED_CLI set to "<package>@<version>", the exact
 * version it pins. npm exec can reach another installed version under the same bin name, so the CLI refuses to run
 * as any version but that one. A matching expectation is removed, so commands the CLI starts do not inherit it.
 *
 * @returns the message to print when this CLI is not the expected version, or undefined
 */
export function expectedCliMismatch(
  pkg: { name: string; version: string },
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const expected = env.BARE_EXPECTED_CLI;
  if (!expected?.startsWith(`${pkg.name}@`)) return undefined;
  if (expected === `${pkg.name}@${pkg.version}`) {
    delete env.BARE_EXPECTED_CLI;
    return undefined;
  }
  return `expected ${pkg.name} ${expected.slice(pkg.name.length + 1)}, found ${pkg.version}; run npx ${expected}`;
}
