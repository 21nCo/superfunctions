import { browseFn } from 'browsefn';

async function main(): Promise<void> {
  const browse = browseFn({
    web: {
      defaultProvider: 'puppeteer',
      fallbackChain: ['puppeteer', 'cheerio'],
    },
  });

  const page = await browse.web.getPage('https://example.com', {
    provider: 'puppeteer',
    format: 'markdown',
    javascript: true,
    waitFor: 'networkidle',
    screenshot: {
      fullPage: true,
      format: 'png',
    },
    includeLinks: true,
    includeImages: true,
  });

  console.log('Provider:', page.provider);
  console.log('Title:', page.metadata.title);
  console.log('Screenshot bytes:', page.screenshot?.byteLength ?? 0);
  console.log('Links:', page.links?.length ?? 0);
  console.log('Images:', page.images?.length ?? 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
