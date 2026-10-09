// Stand-in for "your app's" own database (POS, ERP, warehouse system...).
// A JSON file keeps the scaffold dependency-free; swap these functions for
// real queries against MySQL/Postgres/whatever your system uses.
//
// Each product row:
//   { sku, name, stock, updatedAt,
//     shopify: { inventoryItemId, lastSyncedQty } }   <- the link to Shopify
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/local-db.json');

const SEED = [
  { sku: 'TSHIRT-BLK-M', name: 'T-shirt black M', stock: 12 },
  { sku: 'MUG-WHITE', name: 'White mug', stock: 30 },
];

function load() {
  if (!fs.existsSync(FILE)) {
    const now = new Date().toISOString();
    save(SEED.map((p) => ({ ...p, updatedAt: now, shopify: null })));
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function save(rows) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
}

export function allProducts() {
  return load();
}

export function findBySku(sku) {
  return load().find((p) => p.sku === sku) ?? null;
}

export function findByInventoryItem(inventoryItemId) {
  return load().find((p) => p.shopify?.inventoryItemId === inventoryItemId) ?? null;
}

export function updateProduct(sku, patch) {
  const rows = load();
  const row = rows.find((p) => p.sku === sku);
  if (!row) throw new Error(`Unknown SKU ${sku}`);
  Object.assign(row, patch);
  save(rows);
  return row;
}
