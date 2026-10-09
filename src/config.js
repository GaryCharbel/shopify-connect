import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  shop: required('SHOPIFY_SHOP'),
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  clientId: process.env.SHOPIFY_CLIENT_ID || '',
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
  locationId: process.env.SHOPIFY_LOCATION_ID || '',
  port: Number(process.env.PORT || 3000),
  publicUrl: process.env.PUBLIC_URL || '',
  reconcileIntervalSeconds: Number(process.env.RECONCILE_INTERVAL_SECONDS ?? 300),
};

if (!config.accessToken && !(config.clientId && config.clientSecret)) {
  throw new Error('Set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
}
