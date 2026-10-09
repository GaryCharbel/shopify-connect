# shopify-connect

A minimal scaffold showing how to **connect an app to a Shopify store** and keep
**stock in two-way sync** between that app (a POS, ERP, warehouse system…) and
Shopify.

Node.js 20+, Express, GraphQL Admin API `2026-07`. No database — `src/local/store.js`
is a JSON-file stand-in for your system; swap it for real queries.

```
          your app                                   Shopify
 ┌──────────────────────┐   inventorySetQuantities   ┌──────────────┐
 │ stock changes        │ ─────────────────────────▶ │              │
 │ (POST /api/.../stock)│                            │  inventory   │
 │                      │ ◀───────────────────────── │  levels      │
 │ /webhooks/inventory  │  inventory_levels/update   │              │
 └──────────┬───────────┘       webhook (HMAC)       └──────┬───────┘
            │            periodic full reconcile            │
            └──────────── productVariants query ◀───────────┘
```

## How it works

| Piece | File | What it shows |
|---|---|---|
| Connect the app | `src/shopify/auth.js` | Client credentials grant (Dev Dashboard app) or a static Admin API token |
| API client | `src/shopify/client.js` | GraphQL calls with throttling retry |
| Inventory | `src/shopify/inventory.js` | Read stock, set stock with compare-and-set + `@idempotent` |
| Webhooks | `src/shopify/webhooks.js` | HMAC verification, subscribing to `INVENTORY_LEVELS_UPDATE` |
| Sync engine | `src/sync/engine.js` | Two-way merge, loop prevention, reconcile |
| HTTP server | `src/server.js` | Webhook endpoint + demo API |

### The two-way sync rule

Per product we store `lastSyncedQty`, the last quantity both sides agreed on.
On any change:

```
merged = baseline + (local - baseline) + (shopify - baseline)
```

- A sale in the app and an online order at the same time are **both** kept.
- When our own write echoes back as a webhook, the Shopify side hasn't moved
  from the baseline, so nothing happens. No sync loops.
- Writes use `changeFromQuantity`. If Shopify changed in between, the write is
  rejected rather than overwriting, and the next reconcile fixes it.
- On the first link, Shopify's quantity wins.

Products are linked to Shopify variants **by SKU** during reconcile.

## Setup

1. **Create the app.** In the Shopify [Dev Dashboard](https://dev.shopify.com/dashboard),
   create an app, give it the scopes
   `read_products, read_inventory, write_inventory, read_locations`, and install
   it on your store. Copy the **Client ID** and **Client secret**.
2. **Configure.**
   ```bash
   cp .env.example .env      # fill in SHOPIFY_SHOP + client id/secret
   npm install
   npm run check             # confirms the connection and lists location IDs
   ```
   Put the location you want to sync into `SHOPIFY_LOCATION_ID`.
3. **Expose a public URL** for webhooks, e.g. `cloudflared tunnel --url http://localhost:3000`,
   and set it as `PUBLIC_URL`.
4. **Run.**
   ```bash
   npm run register-webhooks   # once
   npm start
   ```

## Try it

```bash
curl localhost:3000/api/products                       # local stock + Shopify links
curl -X POST localhost:3000/api/sync/reconcile          # link by SKU + fix drift
curl -X POST localhost:3000/api/products/MUG-WHITE/stock \
     -H 'Content-Type: application/json' -d '{"delta": -1}'   # sell one → pushed to Shopify
```

Then change the quantity in the Shopify admin and watch the webhook update
`data/local-db.json`.

## Going further

- **Public / multi-store app:** use the OAuth authorization-code flow (or
  Shopify CLI + `@shopify/shopify-app-remix`) and store one token per shop.
- **Real database:** replace `src/local/store.js`. Keep `lastSyncedQty` per product.
- **Webhooks via config:** declare them in `shopify.app.toml` instead of
  `scripts/register-webhooks.js`.
- **Queue:** process webhooks through a queue so bursts and retries are safe.
- **Multiple locations:** key the link by `(inventoryItemId, locationId)`.

## Docs

- [inventorySetQuantities](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/inventorySetQuantities)
- [Manage inventory quantities](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states)
- [inventoryItem query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/inventoryItem)
- [webhookSubscriptionCreate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/webhookSubscriptionCreate)
