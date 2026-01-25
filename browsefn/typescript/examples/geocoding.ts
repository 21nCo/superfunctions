/**
 * Geocoding example using Nominatim (OpenStreetMap)
 */

import { browseFn } from '../src/index.js';

async function main() {
  const browse = browseFn({
    geo: {
      defaultProvider: 'nominatim',
      providers: {
        nominatim: {
          endpoint: 'https://nominatim.openstreetmap.org',
          userAgent: 'BrowseFnExample/1.0',
          rateLimit: { requests: 1, window: 1000 } // 1 request per second
        }
      },
      cache: {
        enabled: true,
        defaultTTL: 86400000 // 24 hours
      }
    }
  });

  console.log('=== Reverse Geocoding ===\n');

  // Reverse geocode (coordinates to address)
  const location = { lat: 40.7128, lng: -74.0060 }; // New York City
  const address = await browse.geo.reverseGeocode(location, { cache: true });

  console.log('Location:', `${location.lat}, ${location.lng}`);
  console.log('Address:', address.address.formatted);
  console.log('City:', address.address.city);
  console.log('State:', address.address.state);
  console.log('Country:', address.address.country);
  console.log('Cached:', address.cached);
  console.log();

  console.log('=== Forward Geocoding ===\n');

  // Forward geocode (address to coordinates)
  const addressStr = '1600 Amphitheatre Parkway, Mountain View, CA';
  const locations = await browse.geo.geocode(addressStr, {
    limit: 3,
    cache: true
  });

  console.log(`Search: "${addressStr}"`);
  console.log(`Found ${locations.length} results:\n`);

  locations.forEach((loc, index) => {
    console.log(`${index + 1}. ${loc.address.formatted}`);
    console.log(`   Coordinates: ${loc.location.lat}, ${loc.location.lng}`);
    console.log(`   City: ${loc.address.city}`);
    console.log(`   State: ${loc.address.state}`);
    console.log();
  });

  // Get cache statistics
  if (browse.cache) {
    const stats = await browse.cache.getStats();
    console.log('Cache Statistics:');
    console.log('  Hit Rate:', stats.hitRate.toFixed(2) + '%');
    console.log('  Size:', stats.size);
  }
}

main().catch(console.error);
