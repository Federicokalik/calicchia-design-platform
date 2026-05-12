import { notFound } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import {
  EditorialArticleLayout,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';

export const metadata: Metadata = {
  title: {
    absolute:
      'English-Speaking Web Designer in Italy · For Expats, International Businesses, and Foreign Buyers | Federico Calicchia',
  },
  description:
    "English-speaking freelance web designer & developer based in Italy. For expats running businesses in Italy, foreign companies entering the Italian market, real estate agencies serving foreign buyers. Native Italian + fluent English, EU rates.",
  alternates: { canonical: '/en/english-speaking-web-designer-italy' },
  openGraph: {
    title: 'English-Speaking Web Designer in Italy',
    description:
      "For expats, international businesses entering Italy, and Italian businesses serving foreign clients. Bilingual native Italian + fluent English.",
    url: '/en/english-speaking-web-designer-italy',
    locale: 'en_GB',
  },
};

const TYPICAL_CLIENTS = [
  {
    label: 'Expats running businesses in Italy',
    detail:
      "British, American, German, Dutch expats who've moved to Italy and started a business — boutique B&Bs in Tuscany, wine importers in Piemonte, language schools in Florence, holiday rentals in Puglia.\nThey need someone who speaks their native business language but understands Italian bureaucracy, suppliers, and customer expectations.",
  },
  {
    label: 'Foreign companies entering the Italian market',
    detail:
      "UK, US, German companies opening Italian operations or selling cross-border to Italian customers.\nThey need an Italian-language site that doesn't read translated, GDPR + Italian privacy compliance handled, and a developer who can brief in English while writing Italian copy that converts.",
  },
  {
    label: 'Italian businesses serving foreign clients',
    detail:
      "Real estate agencies selling Tuscan villas to international buyers, luxury hotels with English-speaking guests, professional services firms (legal, tax, immigration) helping expats.\nThey need bilingual sites where the English is genuinely good — not Google Translate output.",
  },
  {
    label: 'International remote teams with Italian operations',
    detail:
      "Distributed companies with European HQ in Italy, cross-border SaaS with Italian compliance needs, EU agencies needing Italian-market localization.\nEnglish-first communication, Italian execution.",
  },
];

const COMMON_PROBLEMS = [
  {
    n: '01',
    title: 'Italian agency that "speaks English" — sort of',
    body:
      "You hire an Italian web agency that lists 'English-speaking team' on the site.\nReality: the account manager speaks survival English, the actual designer/developer speaks none, briefs get translated badly in both directions, deadlines slip because every email needs a translation pass.\nBy month 3 you're frustrated and the project is 4 weeks late.",
  },
  {
    n: '02',
    title: 'UK/US agency with no Italian context',
    body:
      "You hire a UK or US agency to avoid the language problem.\nThey build a site that's technically fine but completely wrong for the Italian market: missing P.IVA in footer, no GDPR consent the way Italian regulators expect, contact form without WhatsApp button (which 90% of Italian customers use), language switcher that defaults wrong, address format that doesn't match Italian conventions.",
  },
  {
    n: '03',
    title: 'Translated copy that screams "translated"',
    body:
      "Italian-language version of an English site that was clearly run through Google Translate or done by a junior translator.\nCases (lei vs tu) inconsistent, tone shifts mid-paragraph, idioms calqued from English ('a lungo termine' vs more natural 'nel lungo periodo').\nItalian customers spot it within a sentence and the trust drops.",
  },
  {
    n: '04',
    title: 'Two separate freelancers, broken hand-off',
    body:
      "You hire one English-speaking developer + one Italian translator.\nHand-off between them is messy: developer doesn't know the Italian copy is too long for the design until the translation arrives, translator doesn't know which strings are technical vs marketing.\nYou end up project-managing the integration yourself.",
  },
];

const FAQS = [
  {
    q: "Why are you better than an Italian agency that 'has English-speaking team members'?",
    a: "Because I work in English daily, not just 'when needed'.\nBriefs in English, written specs in English, async messaging in English, calls in English.\nItalian gets used only for actual Italian-language deliverables (copy, customer-facing strings).\nNo translation overhead, no 'I'll send your message to our designer who doesn't speak English'.\nOne person, two languages, zero handoff.",
  },
  {
    q: 'What if I need both English and Italian versions of the site?',
    a: "Standard.\nThe i18n architecture supports both languages natively (Next.js + next-intl), I write the Italian copy as a native and the English copy as fluent professional English, the design accommodates Italian's tendency to be 15-20% longer than English without breaking layouts.\nYou get one consistent voice across both languages because it comes from one person.",
  },
  {
    q: "I'm an expat running a B&B in Tuscany. Is this overkill for me?",
    a: "Maybe.\nFor a 4-room B&B with seasonal bookings, a Squarespace or Airbnb-only setup is often the right call (low cost, low maintenance).\nI'd advise against custom development unless you have specific needs: direct booking channels to avoid OTA commissions, multi-property management, integration with property management software, or you're scaling beyond 4-6 rooms.\nDiscovery call clarifies which side of that line you're on.",
  },
  {
    q: 'How do I know your English is actually good enough for business?',
    a: "Reading this page is the easiest test.\nThe discovery call is the next test.\nI work daily in English with UK / US / EU clients on technical and marketing content.\nReferences available on request — clients on both sides of the language divide.",
  },
  {
    q: 'Do you handle Italian VAT (P.IVA / IVA) compliance for my e-commerce?',
    a: "Yes.\nItalian VAT setup in WooCommerce / Shopify / custom Stripe is part of any e-commerce project: 22% standard rate, reduced rates for specific categories (4% essential goods, 5% feminine hygiene, 10% restaurant + utilities + some services), reverse-charge B2B EU, distance selling thresholds.\nFor non-Italian companies selling to Italy, OSS (One-Stop-Shop) registration is what you actually want — I help configure it.",
  },
  {
    q: 'Can you handle multi-language beyond English/Italian?',
    a: "Architecture-wise yes, the i18n system supports any language.\nFor German, French, Spanish I work with native translators (have a few in network).\nI write the Italian and English copy myself, coordinate with translators for other languages, integrate them into the i18n system.\nYou don't pay extra for the framework supporting more languages — only for the translation work itself.",
  },
  {
    q: "I'm in Italy 6 months a year — do meeting times work?",
    a: "Yes.\nWhen you're in Italy, we're in the same time zone — calls anytime in normal working hours.\nWhen you're abroad (US East coast common for expats with family there), I'm 6h ahead, sweet spot for calls is 14:00-17:00 ET = 20:00-23:00 CET.\nAsync on Slack/Linear covers everything else.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'who', number: '01', label: 'Who this is for' },
  { id: 'clients', number: '02', label: '4 typical client profiles' },
  { id: 'problems', number: '03', label: '4 problems with the alternatives' },
  { id: 'approach', number: '04', label: 'How I work bilingually' },
  { id: 'compliance', number: '05', label: 'Italian compliance + foreign business reality' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function EnglishSpeakingItalyPage() {
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'English-Speaking Web Designer in Italy',
            description:
              'Native Italian, fluent English. For expats, international businesses entering Italy, and Italian businesses serving foreign clients.',
            url: '/en/english-speaking-web-designer-italy',
            section: 'Freelance Services',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Freelance Web Designer Italy', url: '/en/freelance-web-designer-italy' },
            {
              name: 'English-Speaking Web Designer Italy',
              url: '/en/english-speaking-web-designer-italy',
            },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Freelance Web Designer Italy', url: '/en/freelance-web-designer-italy' },
          { name: 'English-Speaking', url: '/en/english-speaking-web-designer-italy' },
        ]}
        eyebrow="Long-tail positioning — 6 chapters · 6 min read"
        title="English-speaking web designer in Italy. For expats, international businesses, and bilingual operations."
        lead={
          <>
            Native Italian + fluent professional English from one person.\nFor expats running
            businesses in Italy, foreign companies entering the Italian market, Italian businesses
            serving international clients.\nNo translation hand-offs, no agency overhead, GDPR + Italian
            P.IVA compliance handled by default.
          </>
        }
        chapters={CHAPTERS}
        readTime="6 min"
        updatedAt="May 8, 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Who */}
        <section id="who" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            01 — Who this page is for
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            You need a web designer or developer who works in English fluently AND understands
            Italian business reality.\nThat combination is harder to find than it should be.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Italian agencies sometimes claim "English-speaking team" but the practice is usually
            limited to a sales person with survival English and a designer who needs everything
            translated.\nUK/US agencies handle English natively but miss Italian-market specifics
            (P.IVA, IVA reverse-charge, GDPR-Italian-style, WhatsApp-first customer behavior).
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>I work in English daily, write Italian as a native, build in EU regulatory
            context, and bill in EUR / GBP / USD.</strong> One person, both languages, both legal
            frameworks.
          </p>
        </section>

        {/* Cap 02 — Clients */}
        <section id="clients" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            02 — 4 typical client profiles
          </p>
          <ul className="flex flex-col">
            {TYPICAL_CLIENTS.map((c, i) => (
              <li
                key={c.label}
                className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-4 md:gap-12 py-8"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    style={{ background: 'var(--color-accent)', width: 8, height: 8, marginTop: 8 }}
                  />
                  <h3
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.25rem, 1.8vw, 1.5rem)',
                      fontWeight: 500,
                      lineHeight: 1.2,
                    }}
                  >
                    {c.label}
                  </h3>
                </div>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {c.detail}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Problems */}
        <section id="problems" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            03 — 4 problems with the alternatives
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {COMMON_PROBLEMS.map((p) => (
              <li
                key={p.n}
                className="flex flex-col gap-4 p-6 md:p-8"
                style={{ border: '1px solid var(--color-line)' }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    letterSpacing: '0.18em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {p.n} — Problem
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.25rem, 1.8vw, 1.625rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}
                >
                  {p.title}
                </h3>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {p.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 04 — Approach */}
        <section id="approach" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            04 — How I work bilingually
          </p>
          <ul className="flex flex-col gap-4 max-w-[65ch] list-disc pl-6 whitespace-pre-line text-justify">
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Briefs in your preferred language.</strong> Most non-Italian clients prefer
              English; some Italian clients prefer Italian.\nI match.\nMid-meeting language switching
              works fine if your team is mixed.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Site copy in both languages, written natively.</strong> No translation
              hand-off.\nThe Italian version reads like an Italian wrote it (because I did), the
              English version reads like fluent professional English (because I write it daily).
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Design accommodates language differences.</strong> Italian text typically runs
              15-20% longer than English.\nThe design accounts for this — buttons, headlines, navigation
              don't break when language switches.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Bills in your currency.</strong> EUR, GBP, USD via wire transfer or Wise/Revolut.\nStandard 50% upfront / 50% on delivery for fixed projects.\nMonthly retainer for ongoing.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Async tools work in English.</strong> Slack, Linear, Notion, Figma, GitHub
              Issues — all in English by default.\nProject board you can read at a glance.
            </li>
          </ul>
        </section>

        {/* Cap 05 — Compliance */}
        <section id="compliance" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            05 — Italian compliance + foreign business reality
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Operating a business that touches the Italian market means handling Italian-specific
            compliance that UK/US agencies routinely miss.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>P.IVA + IVA basics:</strong> Italian VAT (IVA) is 22% standard, reduced rates
            for specific categories.\nP.IVA must appear in site footer for VAT-registered businesses.\nReverse-charge B2B EU.\nOSS for distance selling.\nI configure all this in WooCommerce /
            Shopify / Stripe correctly.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>GDPR Italian-style:</strong> Italian Garante della Privacy is one of the more
            active EU privacy regulators.\nCookie consent must be granular (categories, not single
            accept), data processing agreements with all third-party processors, privacy policy
            that meets Italian regulatory expectations (more detailed than typical UK/US version).
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Italian customer behavior:</strong> WhatsApp is the default contact channel for
            most Italian businesses (more than email or phone).\nTap-to-WhatsApp button on mobile is
            non-negotiable.\nItalian customers expect human response, not bot — auto-reply tolerated
            only as ack, not as actual response.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>European Accessibility Act:</strong> EAA in vigore from June 28, 2025.\nMandatory
            for B2C digital services in the EU.\nWCAG 2.1 AA compliance.\nItalian fines up to €40k per
            violation.\nI bake this into every project as default, not retrofit.
          </p>
        </section>

        {/* Cap 06 — FAQs */}
        <section id="faqs" className="mb-20 md:mb-28 scroll-mt-32">
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-muted)',
            }}
          >
            06 — FAQs
          </p>
          <ul className="flex flex-col">
            {FAQS.map((f, i) => (
              <li
                key={i}
                className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-4 md:gap-12 py-8"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                    fontWeight: 500,
                    lineHeight: 1.2,
                  }}
                >
                  {f.q}
                </h3>
                <p
                  className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {f.a}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </EditorialArticleLayout>
    </>
  );
}
