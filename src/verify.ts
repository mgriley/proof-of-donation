import type { AuthenticateOptions } from 'mailauth';
import type { ReceiptPlugin } from './types.js';
import { verifyEmail } from './email.js';
import { ReceiptStore, receiptIdFor } from './db.js';

export interface VerifyRequest {
  emlBuffer: Buffer;
  /** The email address the caller is trying to prove donated -- must match the receipt's To: address. */
  claimedEmail: string;
  minAmount: number;
  maxAgeHours: number;
  /** Required ISO 4217 currency code. If omitted, any currency the plugin reports is accepted. */
  currency?: string;
  /** Restrict matching to one specific installed plugin id. If omitted, all enabled plugins are tried. */
  pluginId?: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  pluginId?: string;
  charity?: string;
  amount?: number;
  currency?: string;
  donatedAt?: string;
}

export async function verifyDonation(
  req: VerifyRequest,
  plugins: ReceiptPlugin[],
  store: ReceiptStore,
  maxAgeHoursCeiling: number,
  /** Test-only hook to inject a mock DNS resolver; production callers should omit this. */
  authOverrides: Partial<AuthenticateOptions> = {}
): Promise<VerifyResult> {
  if (!req.claimedEmail || !req.claimedEmail.includes('@')) {
    return { valid: false, reason: 'claimedEmail is required and must be a valid email address' };
  }
  if (!Number.isFinite(req.minAmount) || req.minAmount < 0) {
    return { valid: false, reason: 'minAmount must be a non-negative number' };
  }
  if (!Number.isFinite(req.maxAgeHours) || req.maxAgeHours <= 0) {
    return { valid: false, reason: 'maxAgeHours must be a positive number' };
  }
  if (req.maxAgeHours > maxAgeHoursCeiling) {
    return { valid: false, reason: `maxAgeHours exceeds this server's limit of ${maxAgeHoursCeiling}` };
  }

  const candidatePlugins = req.pluginId ? plugins.filter((p) => p.id === req.pluginId) : plugins;
  if (candidatePlugins.length === 0) {
    return {
      valid: false,
      reason: req.pluginId ? `unknown or disabled plugin "${req.pluginId}"` : 'no plugins enabled on this server'
    };
  }

  let auth;
  try {
    auth = await verifyEmail(req.emlBuffer, authOverrides);
  } catch (err) {
    return { valid: false, reason: `could not parse the uploaded message: ${(err as Error).message}` };
  }

  if (auth.passingDkimDomains.length === 0) {
    return { valid: false, reason: 'no passing DKIM signature found on the uploaded message' };
  }

  const matches = candidatePlugins.filter((p) =>
    p.trustedDkimDomains.some((d) => auth.passingDkimDomains.includes(d.toLowerCase()))
  );
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

    if (receipt.donorEmail.toLowerCase() !== req.claimedEmail.toLowerCase()) {
      return {
        valid: false,
        reason: "receipt's donor email does not match the claimed email address",
        pluginId: plugin.id
      };
    }
    if (req.currency && receipt.currency.toUpperCase() !== req.currency.toUpperCase()) {
      return {
        valid: false,
        reason: `receipt currency ${receipt.currency} does not match required currency ${req.currency}`,
        pluginId: plugin.id
      };
    }
    if (receipt.amount < req.minAmount) {
      return {
        valid: false,
        reason: `donation amount ${receipt.amount} ${receipt.currency} is below the required minimum of ${req.minAmount}`,
        pluginId: plugin.id
      };
    }

    const ageHours = (Date.now() - receipt.donatedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours < 0) {
      return { valid: false, reason: 'donation timestamp is in the future', pluginId: plugin.id };
    }
    if (ageHours > req.maxAgeHours) {
      return {
        valid: false,
        reason: `donation happened ${ageHours.toFixed(1)}h ago, older than the allowed ${req.maxAgeHours}h`,
        pluginId: plugin.id
      };
    }

    const receiptId = receiptIdFor(auth.dkimSignatureHeaderLines);
    const claimedFirstUse = store.claim(receiptId, plugin.id, req.claimedEmail);
    if (!claimedFirstUse) {
      return { valid: false, reason: 'this receipt has already been used to validate a signup', pluginId: plugin.id };
    }

    return {
      valid: true,
      pluginId: plugin.id,
      charity: receipt.charityName,
      amount: receipt.amount,
      currency: receipt.currency,
      donatedAt: receipt.donatedAt.toISOString()
    };
  }

  return { valid: false, reason: 'message did not match the receipt format of any enabled plugin for this DKIM domain' };
}
