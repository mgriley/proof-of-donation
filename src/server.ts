import express, { Request, Response } from 'express';
import type { ReceiptPlugin } from './types.js';
import { ReceiptStore } from './db.js';
import { verifyDonation } from './verify.js';

function firstQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function createServer(plugins: ReceiptPlugin[], store: ReceiptStore, maxAgeHoursCeiling: number) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Lets an integrating forum discover what this instance can verify before wiring up.
  app.get('/plugins', (_req, res) => {
    res.json({
      plugins: plugins.map((p) => ({ id: p.id, name: p.name, trustedDkimDomains: p.trustedDkimDomains }))
    });
  });

  app.post('/verify', express.raw({ type: () => true, limit: '10mb' }), async (req: Request, res: Response) => {
    const emlBuffer = req.body;
    if (!Buffer.isBuffer(emlBuffer) || emlBuffer.length === 0) {
      res.status(400).json({ valid: false, reason: 'request body must be the raw .eml message content' });
      return;
    }

    const claimedEmail = firstQueryString(req.query.claimedEmail);
    const minAmountRaw = firstQueryString(req.query.minAmount);
    const maxAgeHoursRaw = firstQueryString(req.query.maxAgeHours);
    const currency = firstQueryString(req.query.currency);
    const pluginId = firstQueryString(req.query.plugin);

    if (!claimedEmail || minAmountRaw === undefined || maxAgeHoursRaw === undefined) {
      res.status(400).json({
        valid: false,
        reason: 'query parameters claimedEmail, minAmount, and maxAgeHours are required'
      });
      return;
    }

    const minAmount = Number(minAmountRaw);
    const maxAgeHours = Number(maxAgeHoursRaw);

    try {
      const result = await verifyDonation(
        { emlBuffer, claimedEmail, minAmount, maxAgeHours, currency, pluginId },
        plugins,
        store,
        maxAgeHoursCeiling
      );
      res.json(result);
    } catch (err) {
      console.error('verify error', err);
      res.status(500).json({ valid: false, reason: 'internal error while verifying receipt' });
    }
  });

  return app;
}
