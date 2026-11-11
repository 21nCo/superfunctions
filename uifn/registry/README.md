# @uifn/registry

The signed, offline-capable registry and transaction-safe source installer for uifn.

Status: `ga-candidate`. The stable catalog contains the 69 canonical components for React, Svelte, and Solid. Vue and Angular are intentionally unsupported.

## One delivery pipeline

Package exports and copied-source modules are generated together from the canonical uifn anatomy. A source template is byte-identical to its package source before installation. The generated catalog records the canonical version, generator version, definition hash, generator hash, template hashes, output hashes, MIT license, dependency requirements, and clean-room provenance.

The bundled catalog is verified with a detached Ed25519 signature before it is used. It does not require a registry network request, and the signing private key is never shipped in the package or repository.

## Maintainer signing

The repository contains only the pinned public key, catalog digest, and detached signature. Never place the private key in the checkout, an `.env` file, shell history, command arguments, CI logs, or a persistent temporary file.

### Interim macOS Keychain custody

Until release signing moves to shared infrastructure, the development key is held as a device-only generic-password item in the login Keychain:

- Service: `uifn-registry-signing-key`
- Account: `local-release-signer`
- Expected key ID: `af26384964522699ef39dd80`

On the authorized Mac, sign from `zsh` without materializing a PEM file:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/sign-uifn-registry.mjs \
  --private-key <(security find-generic-password \
    -a local-release-signer \
    -s uifn-registry-signing-key \
    -w 2>/dev/null | xxd -r -p)
```

The `xxd` step decodes the hexadecimal representation emitted by `security` for the multiline PEM value. Confirm that the command reports key ID `af26384964522699ef39dd80`, review both generated signature files, and run the repository-wide stable gate before committing them. A missing item, a different key ID, or a Keychain access denial is a hard failure; do not generate a replacement key merely to make verification pass.

### AWS KMS migration

Before signing becomes a team operation, replace the local key with an AWS KMS asymmetric signing key configured as:

- Key spec: `ECC_NIST_EDWARDS25519`
- Key usage: `SIGN_VERIFY`
- Origin: `AWS_KMS` (preferred over importing the temporary development key)
- Signing algorithm: `ED25519_SHA_512`
- `Sign` message type: `RAW`

AWS KMS accepts at most 4,096 bytes per `Sign` request, while the generated registry catalog is substantially larger. The KMS cutover therefore requires signature-envelope schema v2. Sign this domain-separated digest rather than the complete catalog bytes:

```text
UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes)
```

Pure Ed25519 signs that small byte sequence in KMS and remains independently verifiable offline with the public key returned by `GetPublicKey`. The verifier must recompute the catalog digest and domain-separated payload itself; it must never trust a digest supplied only by the signature envelope.

The migration is complete only when all of the following are true:

1. Schema-v2 signing and offline-verification tests cover payload tampering, digest tampering, wrong domains, wrong keys, malformed envelopes, and legacy-schema handling.
2. A dedicated release role is the only principal allowed to call `kms:Sign`, restricted to the exact key and `ED25519_SHA_512` algorithm.
3. The signing job runs only in a protected release environment after review. Pull-request code, forked workflows, and ordinary build jobs cannot invoke it.
4. The new public key, key ID, schema-v2 verifier, catalog signature, and generated TypeScript signature are reviewed and landed atomically.
5. `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-uifn-stable.mjs` passes against the final signed catalog, and the KMS signing event is present in CloudTrail.
6. The old Keychain item is retained only for a bounded rollback window, then deleted after all supported releases trust the KMS key.

AWS KMS supports importing asymmetric key material, so preserving the existing key through BYOK is possible. Prefer a newly generated KMS key for the team trust root because the current key originated as a temporary development credential. See the AWS documentation for [Ed25519 asymmetric keys](https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html), [the `Sign` API and message-size limit](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), and [imported key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html).

### Release signing (KMS)

The `uifn registry sign (KMS)` workflow (`.github/workflows/uifn-registry-sign.yml`) signs a branch's catalog with the KMS key. The private key never leaves KMS. It is started by hand only (`workflow_dispatch`), from `dev`, with two inputs:

- `ref`: the branch to sign. It receives the signature commit, so it must be a feature branch, never `dev`, `next` or `main`.
- `expected_sha`: the full commit SHA that the branch head must equal. The run fails if the branch has moved.

The signing configuration lives only in variables of the protected `uifn-release` environment, so a dispatcher cannot change it:

- `UIFN_REGISTRY_SIGNING_ROLE_ARN`: the AWS role assumed through GitHub OIDC.
- `UIFN_REGISTRY_KMS_KEY_ID` and `UIFN_REGISTRY_KMS_REGION`: the KMS signing key and its region.
- `UIFN_REGISTRY_EXPECTED_KEY_ID`: the registry key ID of that KMS key (the first 24 hex characters of SHA-256 over the SPKI DER public key). The signer refuses to sign if KMS returns a different public key, so repointing `UIFN_REGISTRY_KMS_KEY_ID` alone cannot change the signing key. A repository admin sets it once, from the key's public key:

  ```bash
  aws kms get-public-key --key-id "$UIFN_REGISTRY_KMS_KEY_ID" --region "$UIFN_REGISTRY_KMS_REGION" \
    --query PublicKey --output text | base64 --decode | shasum -a 256 | cut -c1-24
  ```

The sign job fails before requesting credentials if any of these variables is missing or the key ID is malformed.

The workflow runs two jobs:

1. **Check branch catalog** has no credentials. It checks out the branch, confirms its head is `expected_sha`, and fails unless regenerating the catalog reproduces the committed files exactly. Only `dev`'s generator may vouch for the catalog: the job fails if the branch's generator scripts (`generate-uifn-registry.mjs` and the modules it loads) differ from the workflow's `dev` commit or are symlinks, so land generator changes on `dev` before signing. It also fails if the branch tracks any signer sidecar file (`*.kms-sign.*`).
2. **Sign registry catalog** runs in the protected `uifn-release` environment. It waits until a maintainer approves the run, and the environment accepts deployments from `dev` only. It gets short-lived AWS credentials through GitHub OIDC for the role in `vars.UIFN_REGISTRY_SIGNING_ROLE_ARN`. The signer runs from the workflow's own `dev` commit, never from the branch: inside the branch checkout it runs `node ../signer/scripts/sign-uifn-registry-kms.mjs`, which signs the checkout in its working directory and accepts no arguments. The key comes from `vars.UIFN_REGISTRY_KMS_KEY_ID` and the region from `vars.UIFN_REGISTRY_KMS_REGION`. The job confirms that the branch head is still `expected_sha`, then commits whichever of `generated/catalog-signature.json` and `src/generated/signature.ts` changed (any other change fails the job) to the branch as a new commit, without force-pushing. Ed25519 signatures are deterministic, so re-signing an unchanged, already signed branch with the same key produces no change; the job then reports that the branch is already signed and commits nothing. The job summary records the ref, signed head, signature commit, catalog SHA-256 and key ID.

The job holds only `id-token: write` and `contents: write`. No `pull_request` or `pull_request_target` event can start it.

`scripts/sign-uifn-registry-kms.mjs` builds the 49-byte schema-v2 input `UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes)` and calls KMS `Sign` with `MessageType: RAW` and `SigningAlgorithm: ED25519_SHA_512`. It fetches the public key with `GetPublicKey` and checks the key ID before signing. It then verifies the returned signature locally against that public key. Only after all of these checks pass does it write the schema-v2 envelope:

```json
{
  "schemaVersion": 2,
  "algorithm": "Ed25519",
  "domain": "uifn-registry-v2",
  "keyId": "<first 24 hex of SHA-256(SPKI DER)>",
  "catalogSha256": "<hex SHA-256 of catalog.json>",
  "signatureBase64": "<64-byte Ed25519 signature>"
}
```

If any check fails, the signer writes nothing and exits non-zero. Replacing the two files is best-effort atomic. A journal (`generated/catalog-signature.json.kms-sign.journal`) is created first, and each original is kept as a `.kms-sign.bak` backup until both files are replaced. If a step fails, the originals are restored. If that restore also fails, or the run is interrupted, the journal and backups stay behind and the error lists them. Once both files are replaced, the journal is rewritten as published before any backup is released. The next signing run settles the pair before it writes anything: it keeps the new pair if the journal says published, and otherwise restores the originals, so it never leaves a mixed pair. A file lookup that fails for any reason other than the file not existing stops the run and keeps the journal and backups. It refuses to start while another live run holds the journal, and it never acts on a journal that is unreadable or names other files. Recovering a dead run's journal assumes no other signer starts on the same checkout at that moment; the workflow runs one signer per fresh checkout. This covers failed or killed runs, not power loss.

Until the schema-v2 verifier and the KMS trust root land, the package still verifies schema v1 with the pinned key above. A branch that carries a KMS signature commit therefore fails the v1 signature checks. Use the workflow only on the branch that lands the v2 verifier and trust root, or on a throwaway branch for an acceptance run.

A push made with the workflow's `GITHUB_TOKEN` does not start other workflows. After the signature commit lands, re-run the pull request's checks, for example by pushing a reviewed follow-up commit, so CI covers the signed head.

## CLI

```bash
uifn list --json
uifn info button --framework react --json
uifn add button --framework react --cwd . --dry-run --json
uifn add button --framework react --cwd . --json
uifn diff --cwd . --json
uifn update button --cwd . --dry-run --json
uifn doctor --cwd . --json
uifn remove button --cwd . --dry-run --json
uifn validate --json
uifn preset encode --style atlas --base-color mauve --json
uifn preset decode <code> --json
uifn preset resolve --cwd . --json
uifn init --preset <code> --dry-run --json
uifn apply --preset <code> --only theme,font --dry-run --json
```

Versioned presets are documented in `docs/PRESET.md`. `init` and `apply` reuse the same transaction, dirty-conflict, and rollback machinery as `add`. The first approved mutation matrix is `react-vite` with `package` or `source` install.

`add` validates the complete plan before writing. It rejects unsupported frameworks, dependency conflicts, dirty tracked files, traversal, symlink escapes, checksum failures, invalid signatures, dependency cycles, and license/provenance failures. Successful writes are staged on the consumer filesystem and committed atomically; an interruption restores the original bytes.

`--dry-run` returns the exact public plan and writes nothing. Repeating an unchanged install is byte-idempotent.

## Consumer metadata

Source installs write:

- `components/uifn/<framework>/...` — generated source owned by the consumer.
- `.uifn/registry.lock` — schema v2 lock entries with framework, version, dependencies, per-file source/output/installed hashes, canonical/generator versions, and provenance.
- `.uifn/preset.json` — normalized `UIFnPresetV1` code plus managed-file hashes used by `uifn apply` and `uifn preset resolve`.
- `.uifn/selected-components.json` — the selected source-mode component index.
- dependency additions in `package.json`, only when they are not already compatible.

Local edits are never silently overwritten or removed. Conflict diagnostics report base, local, and incoming SHA-256 hashes without exposing file contents or local absolute paths.

## Maintainer checks

```bash
npm run generate:check
npm run typecheck
npm test
npm run build
```

Run these commands from the registry package directory after installing its
declared dependencies with `npm install --workspaces=false --package-lock=false`.
`npm pack --json` repeats all four gates through `prepack`.

Generation intentionally uses the repository's canonical phase-16 delivery
generator and React fixture source; it needs the full source checkout but no
root-installed toolchain or built sibling packages. After changing canonical
source or adapter dependency versions, run `npm run generate` and commit the
generated catalog, templates, delivery manifest, and preset fixture source.
If catalog bytes changed, re-sign them with the pinned maintainer key using
the procedure above before running the gates. Never edit generated output
or replace signature validation to bypass drift. The packed runtime bundles
its catalog, detached signature, and fixture source and does not read sibling
packages or repository generator scripts in a consumer install.

The repository-wide delivery gate also creates independent package/source consumers for React, Svelte, and Solid and verifies type checking, production build, SSR, hydration, browser semantics, accessibility, and semantic-trace equivalence.

### Preset applies and npm lockfiles

When full `uifn apply` changes dependencies in a project with `package-lock.json`,
the result includes `requiredActions` if the lockfile's root dependencies differ
from the planned manifest. Dry-run reports the same requirement without writing.
After applying, run `npm install --package-lock-only --ignore-scripts --lockfile-version=3` in the
project directory, review the updated lockfile, then use `npm ci`. UIFn does not
run npm or modify the lockfile inside its file transaction. The required action
continues to be reported on repeat applies until the lockfile is refreshed.

Use npm 7 or newer for this refresh. Lockfile versions 2 and 3 are supported;
version 1 requires the explicit format upgrade above. The check compares root
declarations and the versions of their direct package records. It does not
validate the entire transitive dependency tree or replace npm's own validation.
