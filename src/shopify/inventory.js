// Inventory reads and writes against the GraphQL Admin API.
// Scopes needed: read_products, read_inventory, write_inventory, read_locations
import { randomUUID } from 'node:crypto';
import { shopifyGraphQL } from './client.js';

export async function listLocations() {
  const data = await shopifyGraphQL(`
    query Locations {
      locations(first: 10) { nodes { id name isActive } }
    }`);
  return data.locations.nodes;
}

// Every variant with its SKU, inventory item and "available" stock at one location.
export async function listVariantStock(locationId) {
  const variants = [];
  let cursor = null;
  do {
    const data = await shopifyGraphQL(
      `query Variants($cursor: String, $locationId: ID!) {
        productVariants(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id sku title
            product { title }
            inventoryItem {
              id
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }`,
      { cursor, locationId },
    );
    const page = data.productVariants;
    for (const v of page.nodes) {
      variants.push({
        variantId: v.id,
        sku: v.sku,
        title: `${v.product.title} — ${v.title}`,
        inventoryItemId: v.inventoryItem.id,
        available: v.inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? null,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return variants;
}

// Current "available" stock for one inventory item at one location.
export async function getAvailable(inventoryItemId, locationId) {
  const data = await shopifyGraphQL(
    `query ItemStock($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) {
        id
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`,
    { id: inventoryItemId, locationId },
  );
  return data.inventoryItem?.inventoryLevel?.quantities[0]?.quantity ?? null;
}

// Set absolute "available" quantities. `changeFromQuantity` is the value we
// believe Shopify currently has (compare-and-set): if someone else changed it
// in the meantime Shopify rejects the write instead of silently overwriting.
// Pass null to skip the check. The @idempotent key is required from 2026-04.
export async function setAvailable(locationId, items, reason = 'correction') {
  const data = await shopifyGraphQL(
    `mutation SetQty($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { id changes { name delta quantityAfterChange } }
        userErrors { code field message }
      }
    }`,
    {
      key: randomUUID(),
      input: {
        name: 'available',
        reason,
        referenceDocumentUri: 'app://shopify-connect/sync',
        quantities: items.map((i) => ({
          inventoryItemId: i.inventoryItemId,
          locationId,
          quantity: i.quantity,
          changeFromQuantity: i.changeFromQuantity ?? null,
        })),
      },
    },
  );
  const { userErrors } = data.inventorySetQuantities;
  if (userErrors.length) throw new Error(JSON.stringify(userErrors));
  return data.inventorySetQuantities.inventoryAdjustmentGroup;
}
