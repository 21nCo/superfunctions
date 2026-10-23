import { browseFn } from 'browsefn';

async function main(): Promise<void> {
  const browse = browseFn({
    geo: {
      defaultProvider: 'nominatim',
      providers: {
        nominatim: {
          endpoint: 'https://nominatim.openstreetmap.org',
          userAgent: 'BrowseFnExample/1.0',
        },
      },
    },
    cache: {
      enabled: true,
      ttl: 86_400_000,
    },
  });

  const reverse = await browse.geo.reverseGeocode(
    { lat: 40.7128, lng: -74.006 },
    { provider: 'nominatim' },
  );

  console.log('Reverse provider:', reverse.provider);
  console.log('Reverse address:', reverse.address.formatted);

  const matches = await browse.geo.geocode('1600 Amphitheatre Parkway, Mountain View, CA', {
    provider: 'nominatim',
    limit: 3,
  });

  matches.forEach((result, index) => {
    console.log(index + 1, result.provider, result.location.lat, result.location.lng);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
