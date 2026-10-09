# Integrating Shopify sync into VIDO

How to turn this scaffold into a VIDO feature where **every VIDO shop can connect
its own Shopify store** and keep stock in two-way sync.

- Backend: [`hamsterpos/hamster-pos-system`](https://github.com/hamsterpos/hamster-pos-system), branch **`develop`**
- Frontend: [`hamsterpos/vi-do-frontend`](https://github.com/hamsterpos/vi-do-frontend), branch **`develop`**

File paths below are from `develop` as of Sep 22, 2026 (PR #677).

---

## 1. The big difference from the scaffold: one app, many stores

The scaffold connects **one** store, using a Dev Dashboard app installed on that
store (client credentials). VIDO has many merchants, so:

| | Scaffold | VIDO |
|---|---|---|
| Shopify app | One app per store, created in the store's own org | **One VIDO app**, created in a Shopify **Partner** organization |
| Distribution | none (store-owned) | **Public distribution**. It can be unlisted, but it still goes through Shopify app review |
| Connect flow | client ID + secret in `.env` | **OAuth authorization code grant**: merchant clicks "Connect Shopify" in VIDO and approves the scopes |
| Token storage | `.env` | Encrypted per shop in the DB |
| Webhooks | one subscription | Subscribe per store after install. Handle `app/uninstalled` and the mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) |

Custom distribution only covers a single store, or stores in the same Shopify Plus
organization, so it doesn't fit VIDO.
([Shopify: app distribution](https://shopify.dev/docs/apps/launch/distribution),
[privacy compliance webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance))

**Fallback with no review:** each merchant creates their own Dev Dashboard app and
pastes its client ID and secret into VIDO. That is how the scaffold works today. It's
fine for a pilot shop, but too clunky to roll out widely.

### OAuth flow (per VIDO shop)

```
VIDO portal ──"Connect Shopify"──▶ backend: GET /integrations/shopify/install?shopId=..&shop=x.myshopify.com
   backend builds state (signed: companyId, shopId, nonce) and redirects to
   https://x.myshopify.com/admin/oauth/authorize?client_id=..&scope=..&redirect_uri=..&state=..
merchant approves in Shopify
Shopify ──▶ backend: GET /integrations/shopify/callback?code=..&shop=..&state=..&hmac=..
   verify hmac + state → POST https://x.myshopify.com/admin/oauth/access_token (code → token)
   save encrypted token for (companyId, shopId) → register webhooks → redirect back to portal
```

Scopes: `read_products, read_inventory, write_inventory, read_locations`.

---

## 2. Backend (`hamster-pos-system`)

### What's already there

- **Stack:** Spring Boot 3.4.4, Java 22, hexagonal modules per service
  (`-domain / -application / -dataaccess / -messaging / -interfaces / -grpc / -container`).
  PostgreSQL with one schema per service, Liquibase YAML migrations, Kafka + Avro,
  gRPC between services, outbox publisher, `@Scheduled` + ShedLock.
- **Tenancy:** **Company** = tenant, **Shop** = store/branch
  (`organization-service/.../shop/entity/ShopEntity.java`, has `company_id` and `stock_id`).
  The gateway (`api-gateway/.../filter/ClaimRelayFilter.java`) re-stamps
  `X-Company-Id` and `X-Shop-Ids` from the JWT. Services trust those headers.
- **Stock lives in product-service** (schema `product_service`):
  - `catalog_item` (`CatalogItemEntity`): has `sku` and `barcode`. **This is what gets linked to a Shopify variant.**
  - `stock` (`StockEntity`) is a warehouse. A shop points to one through `shop.stock_id`.
  - `stock_item` (`StockItemEntity`): `quantity`, `reserved_quantity` per (stock, catalog item).
  - `stock_diary` (`StockDiaryEntity`) is the ledger: `type` (`StockMovementType`: SALE,
    ADJUSTMENT, PURCHASE, TRANSFER_*…), `quantity_delta`, `balance_after`, `note`, order refs.
- **How stock changes today:**
  - POS/online sales go through gRPC `StockService` (`ReserveStock / ConfirmStock / CommitStock / ReleaseStock`,
    `product-grpc/src/main/proto/stock_service.proto`), called from order-service.
  - Offline POS movements arrive on Kafka topic `pos-stock-movements`.
  - Manual changes go through `StockItemController`: `POST /api/v1/stocks/.../adjustments`.
  - product-service publishes `stock_items` and `stock_diaries` events through the outbox.
- **Third-party integration pattern to copy: payment-service**
  - Per-company credentials: `company_payment_gateway`, with per-shop overrides in `shop_payment_gateway_override`.
  - Encryption: `payment-application/.../adapter/AesEncryptionAdapter.java`.
    ⚠️ It uses `Cipher.getInstance("AES")`, which defaults to ECB. **Use AES-GCM for Shopify tokens.**
  - Inbound webhooks: `payment-interfaces/.../controller/WebhookController.java` at `/api/v1/webhooks/*`.
- **External ID mapping pattern:** `public-api-service` has `partner_product_mapping`
  (external product ID → VIDO product, per company). Copy that shape.

### What to build: `shopify-integration-service`

New service, same module layout as payment-service, own schema `shopify_integration`.

**Tables (Liquibase):**

```
shopify_connection
  id, company_id, shop_id (VIDO), shop_domain, access_token_enc, scopes,
  shopify_location_id, status (ACTIVE/UNINSTALLED/ERROR), installed_at, last_reconcile_at
  unique (shop_id)

shopify_item_link                        -- = the scaffold's `shopify` field per product
  id, connection_id, catalog_item_id, shopify_variant_id, shopify_inventory_item_id,
  last_synced_qty,                       -- the baseline that makes 2-way sync safe
  match_method (SKU/BARCODE/MANUAL), updated_at
  unique (connection_id, catalog_item_id), unique (connection_id, shopify_inventory_item_id)

shopify_webhook_event                    -- dedupe; Shopify retries webhooks
  webhook_id (X-Shopify-Webhook-Id) PK, topic, shop_domain, received_at
```

**Scaffold file → VIDO equivalent:**

| Scaffold | In the new service |
|---|---|
| `src/shopify/auth.js` | OAuth install + callback controller; token read from `shopify_connection` |
| `src/shopify/client.js` | `ShopifyGraphQLClient` (WebClient, retry on 429/THROTTLED) |
| `src/shopify/inventory.js` | Same GraphQL operations, API version `2026-07` (they are validated) |
| `src/shopify/webhooks.js` | HMAC check on the **raw body** using the app secret |
| `src/local/store.js` | gRPC/REST calls to product-service + `shopify_item_link` |
| `src/sync/engine.js` | `StockSyncService`: same baseline-merge logic, one connection at a time |
| `reconcileAll()` | `@Scheduled` + ShedLock job, loops over active connections |

**Data flow:**

- **VIDO → Shopify:** consume `stock_items` (or `stock_diaries`). For each item with a
  `shopify_item_link`, run the merge and call `inventorySetQuantities`.
- **Shopify → VIDO:** the `inventory_levels/update` webhook arrives. Look up the
  connection by `X-Shopify-Shop-Domain`, then the link by `inventory_item_id`, and run
  the merge. If the VIDO side changes, write an ADJUSTMENT through product-service.
  Online orders could instead be recorded as SALE; agree that with the team.
- **Loop protection:** the baseline (`last_synced_qty`) already makes echoes a no-op.
  Also tag your own product-service writes and skip them when they come back on
  `stock_items`. `stock_diary.reason` is an enum, so use `note` or add a `source` column.
- **Which quantity:** Shopify "available" ≈ VIDO `quantity - reserved_quantity`.
  Decide whether to sync on-hand or available, and stay consistent.
- **Many shops, one stock:** several VIDO shops can share a `stock` (warehouse). Link
  Shopify to the **stock that `shop.stock_id` points to**, and don't let two Shopify
  connections write to the same stock without a decision.

**Gateway changes (`api-gateway`):**

1. Add a route for the new service **before** the payment-service route in
   `src/main/resources/application.yml`. Today all of `/api/v1/webhooks/**` goes to
   payment-service (line ~230). Use, for example:
   - `/api/v1/integrations/shopify/**`: authenticated (connect, disconnect, links, status)
   - `/api/v1/integrations/shopify/oauth/callback` and `/api/v1/integrations/shopify/webhooks/**`: public
2. Add the public paths to `config/SecurityConfig.java` (`permitAll`, near line 78, and
   the JWT skip list), and update `SecurityConfigPermitAllTest`.
3. HMAC verification happens **inside the service**; the gateway doesn't check it.

**Endpoints for the frontend (authenticated, scoped by `X-Company-Id` / `X-Shop-Ids`):**

```
GET    /api/v1/integrations/shopify/shops/{shopId}               connection status
GET    /api/v1/integrations/shopify/shops/{shopId}/install-url   returns the OAuth URL
DELETE /api/v1/integrations/shopify/shops/{shopId}               disconnect
GET    /api/v1/integrations/shopify/shops/{shopId}/locations     Shopify locations
PUT    /api/v1/integrations/shopify/shops/{shopId}/location      pick location
GET    /api/v1/integrations/shopify/shops/{shopId}/links         VIDO items ↔ Shopify variants
POST   /api/v1/integrations/shopify/shops/{shopId}/links/auto    auto-match by SKU, then barcode
PUT    /api/v1/integrations/shopify/shops/{shopId}/links/{catalogItemId}   manual link
POST   /api/v1/integrations/shopify/shops/{shopId}/reconcile     run sync now
```

---

## 3. Frontend (`vi-do-frontend`)

Stack: Next.js 16 App Router, React 19, shadcn/Radix + Tailwind v4, SWR + axios,
next-intl (en/fr/ar), React Hook Form + Zod. Follow the repo's documented order:
types → `services/api/...` → SWR hooks → mutation hooks → components → page.

**Copy Payment Settings.** It already does "one provider card per shop":

- Page: `app/portal/company/[companyId]/settings/payment-settings/page.tsx`
- Components: `components/portal/company/payment-settings/` (`MontypayCard` / `MontypayDialog`).
  `PaymentSettingsPage.tsx` has the shop selector (`useUserShops()`).
- API example: `services/api/payment-gateway/shop-payment-gateway.api.ts` (shop ID in the URL path).

**What to add:**

1. **Settings → Integrations → Shopify** at `app/portal/company/[companyId]/settings/integrations/shopify/page.tsx`.
   Register it in `components/portal/company/settings/useSettingsNav.ts`. Optionally add a sub-item
   under the "Sales Channels" group in `app/portal/shared/app-sidebar.tsx`.
2. **ShopifyCard per shop:** shows Not connected / Connected (store domain) / Error.
   - **Connect** calls `install-url`, then sets `window.location` to the returned URL.
   - After the OAuth callback the backend redirects back here with `?shopify=connected`.
   - **Disconnect** uses `ConfirmDialog` (`components/ui/custom/dialogs/confirmation-dialog`).
3. **Location picker:** a dropdown filled from `/locations`.
4. **Product links table:** VIDO catalog items ↔ Shopify variants, with an "Auto-match by SKU/barcode"
   button and a manual picker for items that don't match. Reuse ag-grid like `CatalogItemsList.tsx`.
5. **"Shopify" badge** on `components/portal/company/inventory/catalog-items/CatalogItemsList.tsx` for linked items.
6. **Permissions and licence:**
   - Add an `INTEGRATION_MANAGEMENT` constant in `types/permissions/index.ts` and gate the page with `PermissionGate`.
   - If it's a paid feature, add a feature code in `types/admin/license` and a rule in `lib/feature-routes.ts`.
7. **i18n:** add strings to `messages/en.json`, `fr.json` and `ar.json`.

---

## 4. Suggested order of work

1. Create the VIDO Shopify app in a **Partner** organization, plus a dev store to test on.
2. Backend: the service skeleton, `shopify_connection`, OAuth install/callback, the gateway route
   and public paths. Goal: a dev store can connect.
3. Linking: `shopify_item_link`, auto-match by SKU/barcode, manual link endpoint.
4. Sync: webhook handler (HMAC, dedupe), `stock_items` consumer, reconcile job, using the scaffold's merge logic.
5. Frontend: Shopify settings page, card, location picker, links table.
6. Uninstall and privacy webhooks, then submit the app for Shopify review.

## Open questions for the team

- Sync on-hand or available? How should Shopify online orders appear in VIDO: as an ADJUSTMENT, a SALE, or a real VIDO order?
- One Shopify location per VIDO shop, or per `stock` (warehouse)?
- Is Shopify a paid licence feature?
- What is in `origin/3rd-party-api` (frontend) and `public-api-service` (backend)? Both look like earlier partner-integration work.
