import express from 'express';
import { config } from './config.js';
import * as local from './local/store.js';
import { verifyWebhook } from './shopify/webhooks.js';
import { handleInventoryWebhook, pushProduct, reconcileAll } from './sync/engine.js';

const app = express();

// --- Shopify → app -------------------------------------------------------
// Raw body is required to verify the HMAC signature.
app.post('/webhooks/inventory', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(req.body, req.get('X-Shopify-Hmac-Sha256'))) {
    return res.sendStatus(401);
  }
  // Acknowledge fast (Shopify retries if we take >5s), then process.
  res.sendStatus(200);
  const payload = JSON.parse(req.body.toString('utf8'));
  handleInventoryWebhook(payload).catch((err) => console.error('[webhook]', err.message));
});

// --- App → Shopify -------------------------------------------------------
app.use(express.json());

app.get('/api/products', (_req, res) => res.json(local.allProducts()));

// Simulates a sale/restock in your system, e.g. { "delta": -1 } or { "stock": 20 }
app.post('/api/products/:sku/stock', async (req, res) => {
  const product = local.findBySku(req.params.sku);
  if (!product) return res.status(404).json({ error: 'Unknown SKU' });

  const stock = req.body.stock ?? product.stock + Number(req.body.delta ?? 0);
  local.updateProduct(product.sku, { stock, updatedAt: new Date().toISOString() });

  try {
    const synced = await pushProduct(product.sku);
    res.json({ sku: product.sku, stock: synced ?? stock, pushed: synced != null });
  } catch (err) {
    // Compare-and-set conflicts land here; the next reconcile resolves them.
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/sync/reconcile', async (_req, res) => {
  try {
    res.json(await reconcileAll());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`shopify-connect listening on :${config.port} (${config.shop})`);
  if (!config.locationId) {
    console.warn('SHOPIFY_LOCATION_ID not set — run `npm run check` to find it');
    return;
  }
  if (config.reconcileIntervalSeconds > 0) {
    const run = () => reconcileAll().catch((err) => console.error('[reconcile]', err.message));
    run();
    setInterval(run, config.reconcileIntervalSeconds * 1000);
  }
});
