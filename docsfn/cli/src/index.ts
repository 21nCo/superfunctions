import cac from 'cac';
import pc from 'picocolors';
import path from 'path';
import fs from 'fs/promises';
import { buildManifest, buildSearchIndex } from '@docsfn/core';
import { FsContentProvider } from '@docsfn/provider-fs';
import chokidar from 'chokidar';

const cli = cac('docsfn');

async function loadConfig(cwd: string) {
  const configPath = path.resolve(cwd, 'docsfn.config.js');
  try {
    // Basic dynamic import for now. 
    // Real implementation needs to handle TS compilation or use jiti.
    const mod = await import(configPath);
    return mod.default || mod;
  } catch (e) {
    console.warn(pc.yellow('⚠ Config file not found or invalid, using defaults.'));
    return {
      site: { title: 'Docs' },
      provider: {
        root: cwd,
        docsDir: 'docs',
        blogDir: 'blog',
        apiDir: 'api'
      }
    };
  }
}

async function build(cwd: string, outDir: string) {
  console.log(pc.blue('ℹ Building docs...'));
  
  const config = await loadConfig(cwd);
  
  // Initialize provider based on config
  // For v0, assume FS provider
  const provider = new FsContentProvider({
    root: config.provider?.root || cwd,
    docsDir: config.provider?.docsDir || 'docs',
    blogDir: config.provider?.blogDir || 'blog',
    apiDir: config.provider?.apiDir || 'api'
  });

  const start = Date.now();
  const manifest = await buildManifest(provider, config);
  const searchIndex = await buildSearchIndex(manifest);

  // Write output
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'manifest.json'), 
    JSON.stringify(manifest, null, 2)
  );
  await fs.writeFile(
    path.join(outDir, 'search-index.json'),
    JSON.stringify(searchIndex)
  );

  console.log(pc.green(`✔ Built in ${Date.now() - start}ms`));
}

cli
  .command('build [root]', 'Build the documentation')
  .option('--out <dir>', 'Output directory', { default: '.docsfn' })
  .action(async (root, options) => {
    const cwd = path.resolve(root || '.');
    await build(cwd, path.resolve(cwd, options.out));
  });

cli
  .command('dev [root]', 'Start dev mode')
  .option('--out <dir>', 'Output directory', { default: '.docsfn' })
  .action(async (root, options) => {
    const cwd = path.resolve(root || '.');
    const out = path.resolve(cwd, options.out);
    
    await build(cwd, out);

    console.log(pc.cyan('ℹ Watching for changes...'));
    
    // Watch relevant directories
    // We should read this from config, but for now hardcode common ones
    const watcher = chokidar.watch([
      path.join(cwd, 'docs'),
      path.join(cwd, 'blog'),
      path.join(cwd, 'api'),
      path.join(cwd, 'docsfn.config.js')
    ], { ignoreInitial: true });

    watcher.on('all', async (event, file) => {
      console.log(pc.dim(`Change detected: ${file}`));
      try {
        await build(cwd, out);
      } catch (e) {
        console.error(pc.red('Build failed:'), e);
      }
    });
  });

cli.help();
cli.parse();
