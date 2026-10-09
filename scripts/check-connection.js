// Verifies the app can talk to the store, and lists locations so you can set
// SHOPIFY_LOCATION_ID.
import { config } from '../src/config.js';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { listLocations } from '../src/shopify/inventory.js';

const { shop } = await shopifyGraphQL('query { shop { name myshopifyDomain } }');
console.log(`Connected to ${shop.name} (${shop.myshopifyDomain}), API ${config.apiVersion}\n`);

console.log('Locations:');
for (const loc of await listLocations()) {
  console.log(`  ${loc.id}  ${loc.name}${loc.isActive ? '' : ' (inactive)'}`);
}
