// Subscribes this app to inventory changes. Run once, after PUBLIC_URL points
// at a tunnel or deployed server.
//
// Alternative: declare webhooks in shopify.app.toml if you manage the app with
// Shopify CLI — then Shopify keeps the subscription for you.
import { config } from '../src/config.js';
import { registerWebhook } from '../src/shopify/webhooks.js';

if (!config.publicUrl.startsWith('https://')) {
  throw new Error('PUBLIC_URL must be a public https:// URL');
}

const sub = await registerWebhook('INVENTORY_LEVELS_UPDATE', `${config.publicUrl}/webhooks/inventory`);
console.log(`Registered ${sub.topic} -> ${sub.uri} (${sub.id})`);
