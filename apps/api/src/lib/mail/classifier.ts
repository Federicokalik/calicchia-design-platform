/**
 * Heuristic classifier for incoming email.
 * Categorizes messages Gmail-style: importanti | normali | aggiornamenti | marketing | spam.
 *
 * Deterministic, fast, no LLM calls. Works with whatever signals are available
 * — when called at sync time it has headers; when called to reclassify stored
 * rows it falls back to sender + subject only.
 */

export type MailCategory = 'importanti' | 'normali' | 'aggiornamenti' | 'marketing' | 'spam';

export interface ClassifyInput {
  fromAddr: string | null;
  subject: string | null;
  flags: string[];
  /** true if any List-Unsubscribe header is present */
  listUnsubscribe?: boolean;
  precedence?: string | null;
  autoSubmitted?: string | null;
  /** x-priority / priority / importance header */
  priority?: string | null;
}

const SPAM_FLAG = /junk|\$junk|\$spam/i;

const MARKETING_LOCAL = /^(newsletter|promo|promozioni|offerte|marketing|news|newsletters)@/i;
const MARKETING_DOMAIN = /@(mailchimp|sendgrid|sendinblue|mailerlite|klaviyo|hubspot|constantcontact|activecampaign|mail\.beehiiv|substack|mailjet|brevo)/i;

const AUTO_LOCAL = /^(noreply|no-reply|do-not-reply|donotreply|notifications?|notification|updates?|alerts?|automatic|automated|system|postmaster|mailer-daemon|bounce|root|cron|digest)@/i;
const AUTO_DOMAIN = /@(github|gitlab|bitbucket|stripe|paypal|notion|slack|vercel|netlify|cloudflare|linear|figma|zoom|calendly|trello|asana|monday|intercom)/i;

const URGENT_SUBJECT = /\b(urgente|urgent|asap|scadenza|deadline|importante|important|attenzione|critical|critico)\b/i;

export function classifyMail(input: ClassifyInput): MailCategory {
  const { fromAddr, subject, flags, listUnsubscribe, precedence, autoSubmitted, priority } = input;
  const from = (fromAddr || '').toLowerCase();
  const subj = (subject || '').toLowerCase();

  // 1. SPAM — flagged by server
  if (flags.some((fl) => SPAM_FLAG.test(fl))) return 'spam';

  // 2. MARKETING — strongest signal: List-Unsubscribe header
  if (listUnsubscribe) return 'marketing';
  if (MARKETING_LOCAL.test(from)) return 'marketing';
  if (MARKETING_DOMAIN.test(from)) return 'marketing';

  // 3. AGGIORNAMENTI — automated / notification senders
  if (autoSubmitted && /auto-(generated|replied)/i.test(autoSubmitted)) return 'aggiornamenti';
  if (precedence && /bulk|list|junk/i.test(precedence)) return 'aggiornamenti';
  if (AUTO_LOCAL.test(from)) return 'aggiornamenti';
  if (AUTO_DOMAIN.test(from)) return 'aggiornamenti';

  // 4. IMPORTANTI — explicit priority markers or urgent keywords
  if (priority && /^(1|high|urgent)/i.test(priority.trim())) return 'importanti';
  if (URGENT_SUBJECT.test(subj)) return 'importanti';

  return 'normali';
}
