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
      'Freelance Web Designer & Developer for Canadian Businesses · Italy-based, EU-quality, English & Italian | Federico Calicchia',
  },
  description:
    "Italy-based freelance web designer & developer for Canadian small businesses, professionals and Italian-Canadian community. Bilingual (English / Italian), EU-quality engineering, CAD-friendly rates, PIPEDA-aware, GDPR-native.",
  alternates: { canonical: '/en/freelance-web-designer-canada' },
  openGraph: {
    title: 'Freelance Web Designer & Developer for Canadian Businesses',
    description:
      "Italy-based, bilingual EN/IT, EU-quality engineering, CAD-friendly rates. For Canadian small businesses and Italian-Canadian community.",
    url: '/en/freelance-web-designer-canada',
    locale: 'en_CA',
  },
};

const ADVANTAGES = [
  {
    n: '01',
    title: 'EU rates for Canadian budgets',
    body:
      "Canadian web design rates trend with US rates: agencies in Toronto, Vancouver, Montreal often charge $150-300 CAD/hour.\nItalian freelance rates run notably below that while keeping EU engineering quality.\nFor a small business or professional firm under $25k CAD project budget, the math works dramatically better.",
  },
  {
    n: '02',
    title: 'Bilingual: English + Italian',
    body:
      'Native Italian, professional fluent English.\nFor the Italian-Canadian community in Vaughan, Toronto, Montreal, Hamilton — you can brief in either language, and your clients (parents, suppliers, original-country contacts) can read your site in Italian or English without translation costs.',
  },
  {
    n: '03',
    title: 'Time zone: workable, not perfect',
    body:
      'Italy CET/CEST is 6 hours ahead of Toronto/Eastern, 9 hours ahead of Vancouver/Pacific.\nMeans morning calls for me / afternoon calls for you (sweet spot 14:00-17:00 ET = 20:00-23:00 CET).\nI deliberately overlap working hours with North American clients.\nAsync on Slack/Linear covers the rest.',
  },
  {
    n: '04',
    title: 'GDPR + PIPEDA aware by default',
    body:
      "GDPR compliance is built in (Italy is EU).\nFor Canadian privacy law (PIPEDA + provincial laws like Quebec's Law 25), I default to consent-first design and data minimization.\nIf you sell to EU customers from Canada, GDPR applies anyway — and I've shipped that compliance many times.",
  },
];

const COMPARISON_ROWS = [
  {
    label: 'Cost vs Toronto/Vancouver agency',
    italy:
      'EU freelance rates significantly below typical Canadian agency hourly.\nNo agency overhead, no senior/junior tier markup, no project manager forwarding emails.',
    other:
      'Canadian boutique agencies in Toronto/Vancouver charge $150-300 CAD/hr with layered margins.\nFor a $15-25k CAD project, you fund offices and account managers as much as actual design/dev work.',
  },
  {
    label: 'Time zone overlap',
    italy:
      '6h ahead of Toronto, 9h ahead of Vancouver.\nMorning calls for me, afternoon for you.\nReal-time overlap 13:00-17:00 ET works well.',
    other:
      'Offshore (India, Philippines): 9-12h ahead/behind, async-only collaboration, slower iteration.\nEastern Europe: better, but no language overlap with Italian-Canadian customers.',
  },
  {
    label: 'Languages',
    italy:
      "Native Italian + fluent professional English.\nYou can brief in either, your customers can read the site in either, your suppliers in Italy can read it natively.",
    other:
      'Canadian agencies do English (and French in Quebec).\nItalian is rare.\nOffshore providers usually English-only with cultural communication friction.',
  },
  {
    label: 'Privacy compliance',
    italy:
      'GDPR-native.\nPIPEDA-aware patterns (consent-first, data minimization).\nQuebec Law 25 considerations for QC-based businesses.',
    other:
      'Mixed.\nMany North American agencies bolt on privacy compliance after the fact.\nOffshore: variable, often weak.',
  },
  {
    label: 'Code ownership',
    italy:
      'Modern stack (Next.js, React, TypeScript, Tailwind, headless CMS, Stripe Canada).\nYou own code, hosting, domain, credentials from day one.',
    other:
      'Some agencies use proprietary platforms with vendor lock-in.\nMigration out costs you twice if you ever leave.',
  },
];

const FAQS = [
  {
    q: 'Why hire an Italian freelancer instead of a Toronto/Vancouver agency?',
    a: "Cost-to-quality.\nItalian freelance rates are competitive vs Canadian agency fees with same engineering depth, and you skip the 30-50% agency overhead (offices, managers, hierarchy).\nFor projects under $25k CAD it's almost always the better economic choice.\nFor $50k+ CAD enterprise builds with strict on-site requirements, a Canadian team might still win — but most small business projects don't fit that.",
  },
  {
    q: "I'm Italian-Canadian — does it matter that you're in Italy?",
    a: 'Practically: I speak Italian natively, so if you brief partly in Italian, send Italian materials, or have suppliers/relatives in Italy involved, communication is zero-friction.\nCulturally: I understand both contexts.\nFamily ties (I have family in Vaughan, Ontario) means I work with North American clients regularly and know the small-business cadence on this side of the Atlantic.',
  },
  {
    q: 'How does invoicing work for Canadian clients?',
    a: "I'm VAT-registered in Italy (P.IVA 03160480608).\nFor Canadian clients I invoice in CAD or USD via wire transfer or Wise/Revolut.\nNo Canadian sales tax (GST/HST/PST) applies on services delivered from outside Canada.\nPayment terms typically 50% upfront / 50% on delivery; monthly for retainers.\nClean paper trail for your bookkeeping.",
  },
  {
    q: 'Will my Canadian customers notice the site is built abroad?',
    a: "No.\nThe site lives on whatever Canadian or global hosting we pick (Cloudflare, Vercel, AWS Canada Central).\nDomain stays yours, registered wherever you prefer.\nCurrency, French/English bilingual content, Canadian payment processors (Stripe Canada, Moneris, Helcim), Canada Post integration for shipping — all standard.\nCustomers see a Canadian business, period.",
  },
  {
    q: 'Can you handle French content for Quebec audiences?',
    a: "I don't translate to French myself, but I build sites with i18n architecture ready (English / French / Italian).\nYou provide French translations (or I coordinate with a Quebec-based translator), the system supports them natively.\nFor Quebec-specific compliance (Law 25), I default to GDPR-equivalent consent patterns which exceed Quebec requirements.",
  },
  {
    q: 'What if something breaks at 2am Toronto time?',
    a: "2am Toronto = 8am Italy, which is when I start my day.\nCritical issues monitored via uptime alerts (UptimeRobot, Better Uptime), I get the email and respond within working hours.\nFor genuinely critical e-commerce or SaaS, retainer includes a 24h SLA — anything blocking goes top of queue regardless of time zone.",
  },
  {
    q: 'Have you actually worked with Canadian clients before?',
    a: "Yes.\nThe contact form on this site is the easiest way to ask for specific examples — I'll share what I've done with similar businesses (small/medium retail, professional services, restaurants, real estate, professionals) under NDA-respecting terms.\nNo fake portfolio, no concept work — only shipped projects with verifiable results.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'why-italy', number: '01', label: 'Why Italian freelance for Canada' },
  { id: 'advantages', number: '02', label: '4 concrete advantages' },
  { id: 'comparison', number: '03', label: 'Italy vs Toronto/Vancouver agency' },
  { id: 'community', number: '04', label: 'Italian-Canadian community fit' },
  { id: 'how-it-works', number: '05', label: 'How working across the Atlantic works' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function FreelanceWebDesignerCanadaPage() {
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'Freelance Web Designer & Developer for Canadian Businesses',
            description:
              'Italy-based freelance web designer & developer for Canadian small businesses and Italian-Canadian community. Bilingual EN/IT.',
            url: '/en/freelance-web-designer-canada',
            section: 'Freelance Services',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Freelance Web Designer Canada', url: '/en/freelance-web-designer-canada' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Freelance Web Designer Canada', url: '/en/freelance-web-designer-canada' },
        ]}
        eyebrow="Positioning — 6 chapters · 7 min read"
        title="Freelance Web Designer & Developer for Canadian businesses. Italy-based, bilingual, EU-quality."
        lead={
          <>
            For small businesses, professional firms, and the Italian-Canadian community across Toronto,
            Vaughan, Mississauga, Montreal, Vancouver and beyond.\nModern engineering at European rates,
            English and Italian bilingual, GDPR + PIPEDA aware, no agency middlemen.
          </>
        }
        chapters={CHAPTERS}
        readTime="7 min"
        updatedAt="May 8, 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Why */}
        <section id="why-italy" className="mb-20 md:mb-28 scroll-mt-32">
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
            01 — Why an Italian freelancer makes sense for Canada
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Canadian web design pricing tracks US pricing — agencies in Toronto, Vancouver and Montreal
            charge North American rates without delivering meaningfully more value than European agencies.\nItalian freelance is the arbitrage no one in Canada talks about.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Toronto / Vancouver agencies</strong> are expensive.\nA small business website project
            in Canada typically lands $15-40k CAD with mid-tier agencies.\nHalf of that is paying for
            the agency itself: offices in King West or Yaletown, account managers, project managers,
            senior/junior tier markup.\nThe actual designer-developer time is a fraction.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Offshore providers</strong> (India, Philippines, parts of Eastern Europe) cut cost
            but introduce 9-12h timezone gaps, communication friction, variable code quality.\nFor a
            small business owner who needs to iterate quickly and have someone reachable, offshore is
            often a false economy.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Italian freelance is the middle ground</strong>: EU-quality engineering, English
            and Italian bilingual, time zone workable (6h ahead of Toronto), at rates closer to a senior
            offshore developer but with EU contract protections, GDPR-native compliance, and (crucially)
            cultural overlap with Italian-Canadian community.
          </p>
        </section>

        {/* Cap 02 — Advantages */}
        <section id="advantages" className="mb-20 md:mb-28 scroll-mt-32">
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
            02 — 4 concrete advantages
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {ADVANTAGES.map((a) => (
              <li
                key={a.n}
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
                  {a.n} — Advantage
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.5rem, 2.2vw, 2rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}
                >
                  {a.title}
                </h3>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {a.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Comparison */}
        <section id="comparison" className="mb-20 md:mb-28 scroll-mt-32">
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
            03 — Italy vs Toronto/Vancouver agency vs offshore
          </p>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th
                    className="text-left p-4 align-top"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--color-ink-muted)',
                      borderBottom: '1px solid var(--color-line)',
                      width: '20%',
                    }}
                  >
                    Aspect
                  </th>
                  <th
                    className="text-left p-4 align-top"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1rem, 1.4vw, 1.25rem)',
                      fontWeight: 500,
                      borderBottom: '1px solid var(--color-line)',
                    }}
                  >
                    Italy-based freelance
                  </th>
                  <th
                    className="text-left p-4 align-top"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1rem, 1.4vw, 1.25rem)',
                      fontWeight: 500,
                      borderBottom: '1px solid var(--color-line)',
                    }}
                  >
                    Toronto/Vancouver agency or offshore
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((r, i) => (
                  <tr key={i}>
                    <td
                      className="p-4 align-top"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: '0.18em',
                        textTransform: 'uppercase',
                        color: 'var(--color-accent-deep)',
                        borderBottom: '1px solid var(--color-line)',
                      }}
                    >
                      {r.label}
                    </td>
                    <td
                      className="p-4 align-top text-sm md:text-base leading-relaxed whitespace-pre-line text-justify"
                      style={{
                        color: 'var(--color-ink)',
                        borderBottom: '1px solid var(--color-line)',
                      }}
                    >
                      {r.italy}
                    </td>
                    <td
                      className="p-4 align-top text-sm md:text-base leading-relaxed whitespace-pre-line text-justify"
                      style={{
                        color: 'var(--color-ink-muted)',
                        borderBottom: '1px solid var(--color-line)',
                      }}
                    >
                      {r.other}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Cap 04 — Italian-Canadian community */}
        <section id="community" className="mb-20 md:mb-28 scroll-mt-32">
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
            04 — A note on the Italian-Canadian community
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            About 1.5 million Canadians have Italian heritage.\nThe community is concentrated in the
            Greater Toronto Area (Woodbridge / Vaughan especially), Hamilton, Montreal, Vancouver.\nIf
            your business serves part of that community, building with someone Italian helps in ways
            that are hard to articulate but show up in the details.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Bilingual content done right.</strong> Italian-Canadian businesses often have
            customers who switch between English and Italian.\nA site that handles both languages
            elegantly — without sounding machine-translated — is rare.\nI write Italian as a native
            and English as a daily working language; I can audit translations, write copy in either,
            and structure the i18n properly.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Cultural fit on smaller projects.</strong> Italian-Canadian small business owners
            (restaurants, contractors, professionals, importers, real estate) often want a relationship,
            not just a vendor.\nI work that way: weekly calls, direct WhatsApp/email, no account manager
            buffer.\nIt's how Italian-Canadian businesses tend to do business with each other anyway.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Disclosure:</strong> I have family in Vaughan.\nThat's not a marketing pitch — it's
            why this market matters to me personally and why I'm comfortable working with Canadian
            small businesses across the Atlantic.\nPractical effect: I'm in North American working
            timezone for a few hours every working day already.
          </p>
        </section>

        {/* Cap 05 — How it works */}
        <section id="how-it-works" className="mb-20 md:mb-28 scroll-mt-32">
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
            05 — How working across the Atlantic actually works
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[65ch] whitespace-pre-line text-justify">
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>30-minute discovery call.</strong> Free.\nBest time slot: 13:00-17:00 Eastern
              (afternoon for you, evening for me).\nFor Pacific timezone, 9:00-11:00 PT works (early
              morning for you, afternoon for me).
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Written scope, CAD or USD pricing.</strong> Within 3 working days.\nFixed scope or
              retainer.\nInvoiced in your preferred currency, paid via wire transfer or Wise/Revolut
              (clean, no surprise FX fees).
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Async + weekly sync.</strong> Daily updates on Slack/Linear/Notion (your choice).\nWeekly 30-min video call in your morning / my afternoon.\nYou see progress every week,
              can course-correct anytime.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Pre-launch QA.</strong> Performance audit, accessibility, browser/device testing,
              PIPEDA + GDPR review.\nOptional: French copy-editing pass via Quebec-based partner if you
              need Quebec-compliant content.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Launch + ongoing.</strong> You own everything: code repo, hosting, domain.\nI can
              host on Canadian-region cloud (AWS Canada Central, Cloudflare with Toronto presence) for
              data residency.\nOptional retainer for monitoring, security, content updates.
            </li>
          </ol>
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
