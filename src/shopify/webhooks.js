// Webhooks are how Shopify tells us about changes (the Shopify → app direction).
import crypto from 'node:crypto';
import { config } from '../config.js';
import { shopifyGraphQL } from './client.js';

// Shopify signs each webhook with the app's client secret. Always verify it
// against the *raw* request body before trusting the payload.
export function verifyWebhook(rawBody, hmacHeader) {
  if (!config.clientSecret) {
    console.warn('[webhook] SHOPIFY_CLIENT_SECRET not set — skipping HMAC check (dev only!)');
    return true;
  }
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', config.clientSecret)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function registerWebhook(topic, uri) {
  const data = await shopifyGraphQL(
    `mutation Sub($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id topic uri }
        userErrors { field message }
      }
    }`,
    { topic, webhookSubscription: { uri } },
  );
  const { userErrors, webhookSubscription } = data.webhookSubscriptionCreate;
  if (userErrors.length) throw new Error(JSON.stringify(userErrors));
  return webhookSubscription;
}
