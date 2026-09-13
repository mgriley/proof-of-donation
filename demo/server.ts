import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../src/plugins/loader.js';
import { verifyDonation } from '../src/verify.js';

// A local-only demo: runs the same verifyDonation() logic as the real server, in-process,
// with a tiny Vue frontend for uploading a receipt and seeing the raw JSON result. Nothing
// uploaded here leaves this machine. This is illustrative, not a deployment target -- see
// the project README for the real /verify API and how to self-host it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function firstQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

async function main() {
  const plugins = await loadPlugins();
  if (plugins.length === 0) {
    console.warn('Warning: no plugins loaded -- every verification will fail.');
  }

  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/charities', (_req, res) => {
    res.json({ charities: plugins.map((p) => p.charityInfo) });
  });

  app.post('/api/verify', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
    const emlBuffer = req.body;
    if (!Buffer.isBuffer(emlBuffer) || emlBuffer.length === 0) {
      res.status(400).json({ valid: false, reason: 'Upload a .eml file first.' });
      return;
    }

    const minAmount = Number(firstQueryString(req.query.minAmount) ?? '0');
    const maxAgeHours = Number(firstQueryString(req.query.maxAgeHours) ?? '8760');
    const currencyRaw = firstQueryString(req.query.currency);
    const currency = currencyRaw ? currencyRaw : undefined;

    try {
      const result = await verifyDonation({ emlBuffer, minAmount, maxAgeHours, currency }, plugins);
      res.json(result);
    } catch (err) {
      console.error('verify error', err);
      res.status(500).json({ valid: false, reason: 'internal error while verifying receipt' });
    }
  });

  const port = Number.parseInt(process.env.PORT ?? '8788', 10);
  app.listen(port, () => {
    console.log(`ProofOfDonation demo running at http://localhost:${port}`);
    console.log('Nothing uploaded here leaves this machine -- verification runs entirely in this local process.');
  });
}

main().catch((err) => {
  console.error('Fatal error starting demo:', err);
  process.exit(1);
});
