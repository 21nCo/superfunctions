// Release owner gate (SFNS-121 D8, SFNS-124): a tag publishes only from the repository that owns its release slug
// or Python project in the ownership manifests of the tagged commit. The publish workflows run it right after the
// immutable-tag check, before anything is installed, built or packed.
//
//   node scripts/assert-release-owner.mjs npm <slug>-v<version>
//   node scripts/assert-release-owner.mjs python python-<project>-v<version>
//
// The running repository comes from GITHUB_REPOSITORY.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { OwnersError, REPO_ROOT, canonicalPythonName, loadOwners } from './owners.mjs';
import { parseReleaseTag } from './resolve-release-tag.mjs';

/** The repositories that publish, keyed by the owner value the manifests assign. */
export const PUBLISHING_REPOSITORIES = Object.freeze({ public: '21nCo/superfunctions', next: '21nCo/super-functions.next' });

export class ReleaseOwnerError extends Error {
  /**
   * @param {'unknown-repository' | 'invalid-tag' | 'wrong-repository' | 'unlisted' | 'duplicate-owner' | 'invalid-manifest'} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseOwnerError';
    this.code = code;
    this.details = details;
  }
}

const describe = owner => `${owner} (${PUBLISHING_REPOSITORIES[owner]})`;

/**
 * The owner value ("public" or "next") of a publishing repository; any other repository is refused.
 * GitHub repository names are case-insensitive.
 * @param {string | undefined} repository `owner/name`, normally GITHUB_REPOSITORY
 */
export function releaseRepoKind(repository) {
  const wanted = typeof repository === 'string' ? repository.toLowerCase() : '';
  const match = Object.entries(PUBLISHING_REPOSITORIES).find(([, name]) => name.toLowerCase() === wanted);
  if (!match) {
    const known = Object.keys(PUBLISHING_REPOSITORIES).map(describe).join(' and ');
    throw new ReleaseOwnerError(
      'unknown-repository',
      `Refusing to publish from ${JSON.stringify(repository ?? '')}: only ${known} publish releases (GITHUB_REPOSITORY must name one of them).`,
      { repository },
    );
  }
  return match[0];
}

/**
 * The release a tag names: an npm release slug or a Python project.
 * @param {'npm' | 'python'} kind
 * @param {string} tag
 */
export function releaseOfTag(kind, tag) {
  if (kind === 'npm') {
    try {
      return { kind, name: parseReleaseTag(tag).slug };
    } catch (error) {
      throw new ReleaseOwnerError('invalid-tag', error.message, { tag });
    }
  }
  if (kind === 'python') {
    // Same split as scripts/python_release.py: python-<project>-v<version>, divided at the last "-v".
    const prefix = 'python-';
    const at = typeof tag === 'string' ? tag.lastIndexOf('-v') : -1;
    const name = at > prefix.length && tag.startsWith(prefix) ? tag.slice(prefix.length, at) : '';
    if (name === '' || at + 2 >= tag.length) {
      throw new ReleaseOwnerError('invalid-tag', `Unsupported tag format: ${tag}. Expected python-<project>-v<PEP440-version>.`, { tag });
    }
    return { kind, name };
  }
  throw new ReleaseOwnerError('invalid-tag', `Release kind must be "npm" or "python", not ${JSON.stringify(kind)}`, { kind });
}

/**
 * Refuses a tag whose release is not owned by the running repository, naming the repository that owns it.
 * Ownership is read from the manifests of the checkout (the tagged commit).
 * @param {{ kind: 'npm' | 'python', tag: string, repository: string | undefined, root?: string }} input
 * @returns {{ owner: 'public' | 'next', name: string, repository: string, manifest: string }}
 */
export function assertReleaseOwner({ kind, tag, repository, root = REPO_ROOT }) {
  const running = releaseRepoKind(repository);
  const release = releaseOfTag(kind, tag);
  const label = kind === 'npm' ? 'release' : 'Python project';
  const field = kind === 'npm' ? 'releases' : 'python';
  const same = kind === 'npm' ? (a, b) => a === b : (a, b) => canonicalPythonName(a) === canonicalPythonName(b);

  let owners;
  try {
    owners = loadOwners({ root });
  } catch (error) {
    if (!(error instanceof OwnersError)) throw error;
    if (error.code === 'duplicate-owner' && error.details.field === field && same(error.details.name, release.name)) {
      throw new ReleaseOwnerError(
        'duplicate-owner',
        `Refusing to publish ${tag}: ${error.message}, so both ${describe('public')} and ${describe('next')} claim it; a ${label} must have exactly one owner.`,
        { name: release.name },
      );
    }
    throw new ReleaseOwnerError('invalid-manifest', `Refusing to publish ${tag}: the ownership manifests are invalid: ${error.message}`, { cause: error.code });
  }

  // Look the release up in every manifest present, so a tag in the wrong repository names its owner.
  const lookupRepo = owners.nextManifest ? 'next' : 'public';
  let owner;
  try {
    owner = kind === 'npm' ? owners.ownerOfRelease(release.name, { repo: lookupRepo }) : owners.ownerOfPython(release.name, { repo: lookupRepo });
  } catch (error) {
    if (!(error instanceof OwnersError)) throw error;
    // A public checkout has no next manifest, so an unlisted release may be next's: say so instead of "nobody owns it".
    const verdict = owners.nextManifest
      ? 'so no repository owns it'
      : `the public allow-list; if ${describe('next')} owns it, push the tag there`;
    throw new ReleaseOwnerError('unlisted', `Refusing to publish ${tag} from ${PUBLISHING_REPOSITORIES[running]}: ${error.message}, ${verdict}.`, {
      name: release.name,
    });
  }
  const manifest = owner === 'next' ? owners.nextManifest.file : owners.publicManifest.file;
  if (owner !== running) {
    throw new ReleaseOwnerError(
      'wrong-repository',
      `Refusing to publish ${tag} from ${PUBLISHING_REPOSITORIES[running]}: ${label} ${JSON.stringify(release.name)} is owned by ${describe(owner)} in ${manifest}. Push the tag to ${PUBLISHING_REPOSITORIES[owner]} instead.`,
      { name: release.name, owner, running },
    );
  }
  return { owner, name: release.name, repository: PUBLISHING_REPOSITORIES[running], manifest };
}

// realpath: a symlinked path to this file (such as macOS's /var -> /private/var) must still run the gate, never skip it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [kind, tag] = process.argv.slice(2);
    const result = assertReleaseOwner({ kind, tag, repository: process.env.GITHUB_REPOSITORY });
    console.log(`${tag}: ${result.name} is owned by ${describe(result.owner)} in ${result.manifest}; publishing from ${result.repository} is allowed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
