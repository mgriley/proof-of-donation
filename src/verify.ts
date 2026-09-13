import crypto from 'node:crypto';
import type { DKIMVerifyOptions } from 'mailauth';
import type { ReceiptPlugin } from './plugins/plugin.js';
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
    return { valid: false, reason: 'minAmount must be zero or greater' };
  }
  if (!Number.isFinite(req.maxAgeHours) || req.maxAgeHours <= 0) {
    return { valid: false, reason: 'maxAgeHours must be greater than zero' };
  }

  if (plugins.length === 0) {
    return { valid: false, reason: 'This server has no supported charities configured yet.' };
  }

  let auth;
  try {
    auth = await verifyEmail(req.emlBuffer, dkimOverrides);
  } catch (err) {
    console.error('Failed to parse uploaded message:', err);
    return { valid: false, reason: "The uploaded file isn't a valid email message." };
  }

  if (auth.passingDkimDomains.length === 0) {
    return {
      valid: false,
      reason:
        "This email's authenticity could not be verified -- it may be unsigned, altered after being sent, or its signature may have expired."
    };
  }

  const matches = plugins.filter((p) => p.trustedDkimDomains.some((d) => auth.passingDkimDomains.includes(d.toLowerCase())));
  if (matches.length === 0) {
    return {
      valid: false,
      reason: `This email was sent from a domain (${auth.passingDkimDomains.join(', ')}) that isn't supported by this server.`
    };
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
        reason: `This donation was made in ${receipt.currency}, but ${req.currency} is required.`,
        ...base
      };
    }
    if (receipt.amount < req.minAmount) {
      return {
        valid: false,
        reason: `This donation (${receipt.amount} ${receipt.currency}) is below the required minimum of ${req.minAmount} ${receipt.currency}.`,
        ...base
      };
    }

    const ageHours = (Date.now() - receipt.donatedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours < 0) {
      return { valid: false, reason: "This receipt's donation date is in the future, which isn't valid.", ...base };
    }
    if (ageHours > req.maxAgeHours) {
      return {
        valid: false,
        reason: `This donation was made ${ageHours.toFixed(1)} hours ago, which is older than the allowed ${req.maxAgeHours} hours.`,
        ...base
      };
    }

    return { valid: true, ...base };
  }

  return {
    valid: false,
    reason: "This email was sent from a recognized domain, but its content doesn't match a known donation receipt format."
  };
}
