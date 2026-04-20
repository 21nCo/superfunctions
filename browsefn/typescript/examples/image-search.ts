import { browseFn } from 'browsefn';

async function main(): Promise<void> {
  const apiKey = process.env.UNSPLASH_ACCESS_KEY;

  if (!apiKey) {
    throw new Error('Set UNSPLASH_ACCESS_KEY before running this example.');
  }

  const browse = browseFn({
    images: {
      defaultProvider: 'unsplash',
      providers: {
        unsplash: {
          apiKey,
        },
      },
    },
  });

  const results = await browse.images.search('mountain landscape', {
    provider: 'unsplash',
    page: 1,
    perPage: 10,
    orientation: 'landscape',
    filters: {
      minWidth: 1920,
      safeSearch: true,
    },
  });

  console.log('Provider:', results.provider);
  console.log('Results:', results.results.length);

  for (const image of results.results.slice(0, 3)) {
    console.log(image.id, image.source.provider, image.width, image.height);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
