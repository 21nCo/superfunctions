import { browseFn } from 'browsefn';

async function main(): Promise<void> {
  const browse = browseFn({
    web: {
      defaultProvider: 'cheerio',
    },
    cache: {
      enabled: true,
      ttl: 60_000,
      maxSize: 100,
    },
  });

  const page = await browse.web.getPage('https://example.com', {
    format: 'markdown',
    includeLinks: true,
    includeImages: true,
  });

  console.log('Provider:', page.provider);
  console.log('Title:', page.metadata.title);
  console.log('Links:', page.links?.length ?? 0);
  console.log('Images:', page.images?.length ?? 0);

  const metadata = await browse.web.getMultipleMetadata(
    ['https://example.com', 'https://www.npmjs.com'],
    {
      fields: ['title', 'description'],
      concurrency: 2,
      onProgress: (completed, total) => {
        console.log(`Progress: ${completed}/${total}`);
      },
    },
  );

  metadata.forEach((result, index) => {
    console.log(index, result.success, result.data?.title ?? result.error);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
