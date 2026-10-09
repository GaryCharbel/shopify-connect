// Two-way stock sync.
//
// The trick that makes two-way sync safe is remembering, per product, the last
// quantity both sides agreed on (`shopify.lastSyncedQty`). From that baseline:
//
//   localDelta  = local stock   - baseline   (sales/restocks in your app)
//   remoteDelta = Shopify stock - baseline   (online orders, admin edits)
//   merged      = baseline + localDelta + remoteDelta
//
// Both sides' changes are kept (nothing is overwritten), and a webhook that
// merely echoes our own write has remoteDelta = 0, so it is a no-op — no loops.
import { config } from '../config.js';
import * as local from '../local/store.js';
import { getAvailable, listVariantStock, setAvailable } from '../shopify/inventory.js';

function merge(baseline, localQty, shopifyQty) {
  if (baseline == null) return shopifyQty ?? localQty; // first sync: Shopify wins
  return baseline + (localQty - baseline) + ((shopifyQty ?? baseline) - baseline);
}

// Bring one linked product in line with the given Shopify quantity.
export async function syncProduct(product, shopifyQty) {
  const { inventoryItemId, lastSyncedQty } = product.shopify;
  const merged = merge(lastSyncedQty, product.stock, shopifyQty);

  if (merged !== shopifyQty) {
    // Compare-and-set: fails if Shopify moved since we read shopifyQty.
    await setAvailable(config.locationId, [
      { inventoryItemId, quantity: merged, changeFromQuantity: shopifyQty },
    ]);
  }

  const changed = merged !== product.stock || merged !== lastSyncedQty;
  local.updateProduct(product.sku, {
    stock: merged,
    updatedAt: changed ? new Date().toISOString() : product.updatedAt,
    shopify: { inventoryItemId, lastSyncedQty: merged },
  });

  if (changed) {
    console.log(
      `[sync] ${product.sku}: local ${product.stock}, shopify ${shopifyQty}, base ${lastSyncedQty} -> ${merged}`,
    );
  }
  return merged;
}

// App → Shopify: call this whenever stock changes in your system.
export async function pushProduct(sku) {
  const product = local.findBySku(sku);
  if (!product?.shopify) return null; // not linked to Shopify yet
  const shopifyQty = await getAvailable(product.shopify.inventoryItemId, config.locationId);
  return syncProduct(product, shopifyQty);
}

// Shopify → app: called from the inventory_levels/update webhook.
export async function handleInventoryWebhook(payload) {
  if (`gid://shopify/Location/${payload.location_id}` !== config.locationId) return;
  const product = local.findByInventoryItem(
    `gid://shopify/InventoryItem/${payload.inventory_item_id}`,
  );
  if (!product) return; // a Shopify item we don't track
  await syncProduct(product, payload.available);
}

// Full reconcile: link products by SKU and fix any drift (e.g. missed webhooks).
export async function reconcileAll() {
  const variants = await listVariantStock(config.locationId);
  const bySku = new Map(variants.filter((v) => v.sku).map((v) => [v.sku, v]));

  let linked = 0;
  let synced = 0;
  for (const product of local.allProducts()) {
    const variant = bySku.get(product.sku);
    if (!variant) continue;

    if (!product.shopify) {
      product.shopify = { inventoryItemId: variant.inventoryItemId, lastSyncedQty: null };
      local.updateProduct(product.sku, { shopify: product.shopify });
      linked++;
    }
    try {
      await syncProduct(product, variant.available);
      synced++;
    } catch (err) {
      console.error(`[reconcile] ${product.sku}: ${err.message}`);
    }
  }
  console.log(`[reconcile] ${synced} products synced, ${linked} newly linked`);
  return { synced, linked };
}
