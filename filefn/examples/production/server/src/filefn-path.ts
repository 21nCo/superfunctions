/** Path FileFn sees after the production example strips its `/filefn` mount. */
export function stripFileFnPrefix(pathname: string): string {
  return pathname.replace(/^\/filefn(?=\/|$)/, "") || "/";
}
