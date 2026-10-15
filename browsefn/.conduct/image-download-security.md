# Image download security checkpoint

The built-in TypeScript downloader and Python browser/provider downloaders now use a shared helper within each SDK. These helpers are specialized network/file transfer policy, not framework HTTP adapters.

- HTTP(S) only; credentials in URLs rejected; every redirect is revalidated. Default maximum is five redirects, 20 MiB, and a 30-second overall deadline (including DNS and body transfer).
- Socket lookup in Node validates every DNS answer and hands only those checked addresses to the connection. Python resolves each hop, validates every answer, and connects to a checked IP while preserving the original Host header and TLS SNI/certificate hostname. Python disables environment proxy inheritance and keepalive pooling so pinned IP connections cannot reuse a TLS identity across redirect hostnames.
- Default policy rejects private, loopback, link-local, carrier NAT, multicast, documentation/reserved IPv4, and non-global/transition/documentation IPv6 ranges. It is deliberately conservative. `allowPrivateHosts` (`allow_private_hosts` in Python) explicitly opts into private targets; protocol/redirect/size bounds still apply.
- Payload length is checked against both headers and streamed bytes. Redirect/error streams are closed. Identity encoding is requested; unsolicited compressed HTTP encodings are rejected rather than expanding an unbounded decompression stream. Completed bytes remain buffered up to the configured cap for metadata and publication.
- A unique 0600 temporary file is written and synced in the destination directory. Atomic hard-link publication enforces `overwrite=false` even when concurrent callers raced past the initial existence check. Atomic replacement for overwrite never follows the final destination symlink or truncates another hardlink's target. Failed publication cleans up the temporary file.

## Trust boundaries and limits

The application must own the destination directory and its ancestors; untrusted local users must not be able to rename those directories or substitute ancestor symlinks during a download. This is not a sandbox for a hostile shared filesystem. Final-component symlink/hardlink targets are protected. Atomic no-overwrite publication requires a filesystem supporting hardlinks within the directory; unsupported filesystems fail without claiming success.

Custom TypeScript `ImageProvider.download` implementations remain a trusted extension point and retain their existing transform/provider functionality. They control their own network and filesystem I/O; the built-in downloader's policy cannot constrain arbitrary provider code. The initial lexical filename validation and successful-result path requirement still apply. Applications handling untrusted URLs must use the built-in downloader or a provider implementing equivalent policy. No built-in TypeScript image provider supplies a custom download implementation.

Python's built-in providers all use the shared protected helper. Provider errors remain unsuccessful `DownloadResult`s; browser download errors raise as before. New Python options accept both camelCase and snake_case and reject invalid size/redirect limits.

The subsequent image-transformation checkpoint implements resizing, cropping, quality/format conversion, text/image watermarks, and provider size selection; see image-transformations.md for the exact contract and decoded-image evidence. Live third-party image-service credentials and public HTTPS integration were not exercised; local HTTP acceptance verifies transport and file policy. TLS verification remains enabled in both SDKs.

## Evidence

`typescript/tests/image-browser.test.ts` uses a real localhost HTTP server for metadata/file bytes, batch ordering/errors/progress, relative redirects, redirect loops and unsupported protocols, declared/streamed oversize rejection, literal and DNS-resolved local-address rejection, concurrent overwrite exclusion, and symlink/hardlink preservation. Address classification covers private IPv4, IPv6 mapped/local/transition ranges and known public addresses.

`python/tests/test_image_security.py` runs equivalent real HTTP checks through both ImageBrowser and UnsplashProvider, plus boundary validation. Existing image unit tests mock the shared transfer helper rather than pretending the old buffered HTTP transport is still used.

Python 3.10 focused image tests: 12 passed. Full release gate passes: TypeScript build/typecheck and 94 tests; Python 3.12 compile and 74 tests; duplication 4.893158556293769% (545 lines, 46 clones, 62 files). Log: `/tmp/sf-browse-image-gate.log`. `git diff --check` passes. No hosted download, deployment, or adversarial destination-directory claim is implied.
