// "Connecting the app": how this service gets an Admin API access token.
//
// Option A — Dev Dashboard app installed on your own store:
//   exchange client_id + client_secret for a short-lived token
//   (client credentials grant). We cache it and refresh before it expires.
// Option B — a static Admin API token pasted into .env.
//
// A public (App Store) app would use the OAuth authorization-code flow instead;
// see README "Going further".
import { config } from '../config.js';

let cached = null; // { token, expiresAt }

export async function getAccessToken() {
  if (config.accessToken) return config.accessToken;

  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const res = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 86_400) * 1000,
  };
  return cached.token;
}
