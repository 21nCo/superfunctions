// The workspace root installs React 19 for the docs app. Packages that test
// against their own React copy (for example React 18) use these aliases so
// React, React DOM and @testing-library/react all load from that copy instead
// of mixing two React versions in one test run.
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * @param {string} packageDir absolute path of the package whose React copy to use
 * @returns {{ find: RegExp, replacement: string }[]}
 */
export function packageReactAliases(packageDir) {
  const require = createRequire(path.join(packageDir, 'package.json'));
  const packageRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));
  const react = packageRoot('react');
  const reactDom = packageRoot('react-dom');
  const testingLibrary = packageRoot('@testing-library/react');
  return [
    // The ESM build goes through Vite's resolver; the CommonJS build would
    // require react-dom from the workspace root.
    { find: /^@testing-library\/react$/, replacement: path.join(testingLibrary, 'dist/@testing-library/react.esm.js') },
    { find: /^react$/, replacement: path.join(react, 'index.js') },
    { find: /^react\/(.*)$/, replacement: `${react}/$1` },
    { find: /^react-dom$/, replacement: path.join(reactDom, 'index.js') },
    { find: /^react-dom\/(.*)$/, replacement: `${reactDom}/$1` },
  ];
}
