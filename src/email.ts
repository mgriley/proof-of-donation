import { dkimVerify } from 'mailauth';
import type { DKIMVerifyOptions } from 'mailauth';
import PostalMime from 'postal-mime';
import type { Address } from 'postal-mime';
import type { EmailAddress } from './types.js';

export interface EmailAuthResult {
  /** Unique, lowercased DKIM `d=` domains that had a passing signature. */
  passingDkimDomains: string[];
  /** Raw DKIM-Signature header lines present in the message, used to derive a replay id. */
  dkimSignatureHeaderLines: string[];
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  text?: string;
  html?: string;
}

function toEmailAddress(addr: Address | undefined): EmailAddress | undefined {
  if (!addr?.address) return undefined;
  return { name: addr.name ?? '', address: addr.address.toLowerCase() };
}

/**
 * Runs DKIM verification (header + body hash) on a raw RFC822 message and pulls out
 * the fields needed to match it against a plugin and parse a receipt.
 *
 * Uses mailauth's dkimVerify() rather than its all-in-one authenticate(): authenticate()
 * always runs SPF too (there's no way to disable it), which does DNS lookups against a
 * domain derived from the message's Return-Path/Received headers -- headers an uploaded
 * .eml fully controls and that are essentially never DKIM-signed. Since donation-receipt
 * trust here is anchored entirely to "did this exact domain sign this exact content" (the
 * DKIM result), not envelope/sender alignment, that SPF lookup would be attacker-steerable
 * network activity for a result we'd never use. dkimVerify() does DKIM only.
 *
 * `dkimOverrides` lets callers (namely tests) inject a mock DNS `resolver` instead of
 * hitting real DNS; production code should never need to pass it.
 */
export async function verifyEmail(raw: Buffer, dkimOverrides: Partial<DKIMVerifyOptions> = {}): Promise<EmailAuthResult> {
  const [dkimResult, parsed] = await Promise.all([dkimVerify(raw, dkimOverrides), PostalMime.parse(raw)]);

  const passing = dkimResult.results.filter((r) => r.status.result === 'pass');
  const passingDkimDomains = [...new Set(passing.map((r) => r.signingDomain.toLowerCase()))];

  const headerLines = dkimResult.headers?.parsed ?? [];
  const dkimSignatureHeaderLines = headerLines
    .filter((h) => h.key.toLowerCase() === 'dkim-signature')
    .map((h) => h.line);

  return {
    passingDkimDomains,
    dkimSignatureHeaderLines,
    subject: parsed.subject ?? '',
    from: toEmailAddress(parsed.from) ?? { name: '', address: '' },
    to: (parsed.to ?? []).map(toEmailAddress).filter((a): a is EmailAddress => a !== undefined),
    text: parsed.text,
    html: parsed.html || undefined
  };
}
