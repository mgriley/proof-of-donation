import express, { Request, Response } from 'express';
import type { ReceiptPlugin } from './plugins/plugin.js';
import { verifyDonation } from './verify.js';

function firstQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function createServer(plugins: ReceiptPlugin[]) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // For showing an end user "here's who you can donate to" before they've made a donation.
  app.get('/charities', (_req, res) => {
    res.json({ charities: plugins.map((p) => p.charityInfo) });
  });

  app.post('/verify', express.raw({ type: () => true, limit: '10mb' }), async (req: Request, res: Response) => {
    const emlBuffer = req.body;
    if (!Buffer.isBuffer(emlBuffer) || emlBuffer.length === 0) {
      res.status(400).json({ valid: false, reason: 'Please upload the donation receipt as a raw .eml file.' });
      return;
    }

    const minAmountRaw = firstQueryString(req.query.minAmount);
    const maxAgeHoursRaw = firstQueryString(req.query.maxAgeHours);
    const currency = firstQueryString(req.query.currency);

    if (minAmountRaw === undefined || maxAgeHoursRaw === undefined) {
      res.status(400).json({
        valid: false,
        reason: 'A minAmount and maxAgeHours value are both required.'
      });
      return;
    }

    const minAmount = Number(minAmountRaw);
    const maxAgeHours = Number(maxAgeHoursRaw);

    try {
      const result = await verifyDonation({ emlBuffer, minAmount, maxAgeHours, currency }, plugins);
      res.json(result);
    } catch (err) {
      console.error('verify error', err);
      res.status(500).json({ valid: false, reason: 'Something went wrong while verifying this receipt. Please try again.' });
    }
  });

  return app;
}
