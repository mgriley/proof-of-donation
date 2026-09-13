import { authenticate } from 'mailauth';
import type { AuthenticateOptions } from 'mailauth';
import { simpleParser } from 'mailparser';

export interface EmailAuthResult {
  /** Unique, lowercased DKIM `d=` domains that had a passing signature. */
  passingDkimDomains: string[];
  /** Raw DKIM-Signature header lines present in the message, used to derive a replay id. */
  dkimSignatureHeaderLines: string[];
  subject: string;
  from: string;
  to: string;
  text?: string;
  html?: string;
}

function addressText(addr: { text: string } | { text: string }[] | undefined): string {
  if (!addr) return '';
  return Array.isArray(addr) ? addr.map((a) => a.text).join(', ') : addr.text;
}

/**
 * Runs DKIM verification (header + body hash) on a raw RFC822 message and pulls out
 * the fields needed to match it against a plugin and parse a receipt.
 *
 * Only DKIM is checked -- SPF/DMARC/ARC/BIMI are disabled since donation-receipt trust
 * here is anchored entirely to "did this exact domain sign this exact content", not to
 * envelope/sender alignment.
 *
 * `authOverrides` lets callers (namely tests) inject a mock DNS `resolver` instead of
 * hitting real DNS; production code should never need to pass it.
 */
export async function verifyEmail(raw: Buffer, authOverrides: Partial<AuthenticateOptions> = {}): Promise<EmailAuthResult> {
  const [authResult, parsed] = await Promise.all([
    authenticate(raw, {
      trustReceived: true,
      disableArc: true,
      disableDmarc: true,
      disableBimi: true,
      ...authOverrides
    }),
    simpleParser(raw, { skipHtmlToText: true })
  ]);

  const passing = authResult.dkim.results.filter((r) => r.status.result === 'pass');
  const passingDkimDomains = [...new Set(passing.map((r) => r.signingDomain.toLowerCase()))];

  const headerLines = authResult.dkim.headers?.parsed ?? [];
  const dkimSignatureHeaderLines = headerLines
    .filter((h) => h.key.toLowerCase() === 'dkim-signature')
    .map((h) => h.line);

  return {
    passingDkimDomains,
    dkimSignatureHeaderLines,
    subject: parsed.subject ?? '',
    from: parsed.from?.text ?? '',
    to: addressText(parsed.to),
    text: parsed.text,
    html: parsed.html || undefined
  };
}
