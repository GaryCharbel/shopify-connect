// Thin GraphQL Admin API client with retry on throttling.
import { config } from '../config.js';
import { getAccessToken } from './auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function shopifyGraphQL(query, variables = {}, attempt = 1) {
  const res = await fetch(
    `https://${config.shop}/admin/api/${config.apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await getAccessToken(),
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`Shopify ${res.status} after ${attempt} attempts`);
    await sleep(500 * 2 ** attempt);
    return shopifyGraphQL(query, variables, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();

  const throttled = Array.isArray(body.errors) && body.errors.some((e) => e.extensions?.code === 'THROTTLED');
  if (throttled && attempt <= 5) {
    await sleep(1000 * attempt);
    return shopifyGraphQL(query, variables, attempt + 1);
  }
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
