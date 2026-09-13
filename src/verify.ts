import crypto from 'node:crypto';
import type { DKIMVerifyOptions } from 'mailauth';
import type { ReceiptPlugin } from './types.js';
import { verifyEmail } from './email.js';

export interface VerifyRequest {
  emlBuffer: Buffer;
  minAmount: number;
  maxAgeHours: number;
  /** Required ISO 4217 currency code. If omitted, any currency the plugin reports is accepted. */
  currency?: string;
}

export interface VerifyResult {
  /** Whether the receipt satisfies minAmount/maxAgeHours/currency. Identity binding
   * (does donorEmail match the account being created) is the integrator's job -- see
   * README "Statelessness & the integrator's responsibilities". */
  valid: boolean;
  reason?: string;
  pluginId?: string;
  charity?: string;
  amount?: number;
  currency?: string;
  donatedAt?: string;
  /** The email address the receipt was sent to. Compare this against your own
   * already-verified account email -- this server does not do that comparison for you. */
  donorEmail?: string;
  /**
   * Stable id for this exact receipt (derived from its DKIM signature). Present whenever a
   * receipt was successfully parsed, whether or not it passed the amount/age/currency
   * checks. Store this alongside the created account, in the same transaction, to stop the
   * same receipt being reused for more than one signup -- this server keeps no state of
   * its own and will happily "verify" the same receipt any number of times.
   */
  receiptId?: string;
}

function receiptIdFor(dkimSignatureHeaderLines: string[]): string {
  const basis = [...dkimSignatureHeaderLines].sort().join('\n');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

export async function verifyDonation(
  req: VerifyRequest,
  plugins: ReceiptPlugin[],
  /** Test-only hook to inject a mock DNS resolver; production callers should omit this. */
  dkimOverrides: Partial<DKIMVerifyOptions> = {}
): Promise<VerifyResult> {
  if (!Number.isFinite(req.minAmount) || req.minAmount < 0) {
    return { valid: false, reason: 'minAmount must be a non-negative number' };
  }
  if (!Number.isFinite(req.maxAgeHours) || req.maxAgeHours <= 0) {
    return { valid: false, reason: 'maxAgeHours must be a positive number' };
  }

  if (plugins.length === 0) {
    return { valid: false, reason: 'no plugins enabled on this server' };
  }

  let auth;
  try {
    auth = await verifyEmail(req.emlBuffer, dkimOverrides);
  } catch (err) {
    return { valid: false, reason: `could not parse the uploaded message: ${(err as Error).message}` };
  }

  if (auth.passingDkimDomains.length === 0) {
    return { valid: false, reason: 'no passing DKIM signature found on the uploaded message' };
  }

  const matches = plugins.filter((p) => p.trustedDkimDomains.some((d) => auth.passingDkimDomains.includes(d.toLowerCase())));
  if (matches.length === 0) {
    return { valid: false, reason: 'the passing DKIM domain is not trusted by any enabled plugin' };
  }

  for (const plugin of matches) {
    const dkimDomain = plugin.trustedDkimDomains.find((d) => auth.passingDkimDomains.includes(d.toLowerCase()))!;

    let receipt;
    try {
      receipt = plugin.parse({
        subject: auth.subject,
        from: auth.from,
        to: auth.to,
        text: auth.text,
        html: auth.html,
        dkimDomain
      });
    } catch {
      // A bug in one plugin shouldn't block another enabled plugin from matching.
      continue;
    }
    if (!receipt) continue;

    const base = {
      pluginId: plugin.id,
      charity: receipt.charityName,
      amount: receipt.amount,
      currency: receipt.currency,
      donatedAt: receipt.donatedAt.toISOString(),
      donorEmail: receipt.donorEmail,
      receiptId: receiptIdFor(auth.dkimSignatureHeaderLines)
    };

    if (req.currency && receipt.currency.toUpperCase() !== req.currency.toUpperCase()) {
      return {
        valid: false,
        reason: `receipt currency ${receipt.currency} does not match required currency ${req.currency}`,
        ...base
      };
    }
    if (receipt.amount < req.minAmount) {
      return {
        valid: false,
        reason: `donation amount ${receipt.amount} ${receipt.currency} is below the required minimum of ${req.minAmount}`,
        ...base
      };
    }

    const ageHours = (Date.now() - receipt.donatedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours < 0) {
      return { valid: false, reason: 'donation timestamp is in the future', ...base };
    }
    if (ageHours > req.maxAgeHours) {
      return {
        valid: false,
        reason: `donation happened ${ageHours.toFixed(1)}h ago, older than the allowed ${req.maxAgeHours}h`,
        ...base
      };
    }

    return { valid: true, ...base };
  }

  return { valid: false, reason: 'message did not match the receipt format of any enabled plugin for this DKIM domain' };
}
