/** Path FileFn sees after the production example strips its `/filefn` mount. */
export function stripFileFnPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/filefn/, "") || "/";
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}
