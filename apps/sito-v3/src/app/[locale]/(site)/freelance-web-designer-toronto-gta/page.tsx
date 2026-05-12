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
      'Freelance Web Designer & Developer for the GTA · Toronto, Vaughan, Mississauga, Markham · Bilingual EN/IT | Federico Calicchia',
  },
  description:
    "Italy-based freelance web designer & developer for Greater Toronto Area businesses: Toronto, Vaughan, Mississauga, Markham, Brampton, Hamilton. Bilingual English / Italian, EU-quality engineering, CAD-friendly rates.",
  alternates: { canonical: '/en/freelance-web-designer-toronto-gta' },
  openGraph: {
    title: 'Freelance Web Designer & Developer for the GTA',
    description:
      "Toronto, Vaughan, Mississauga, Markham. Italian-Canadian community fit. Bilingual EN/IT, EU-quality, CAD-friendly rates.",
    url: '/en/freelance-web-designer-toronto-gta',
    locale: 'en_CA',
  },
};

const GTA_AUDIENCES = [
  {
    location: 'Toronto (downtown + midtown + east end)',
    fit:
      "Small businesses, professional service firms (lawyers, accountants, dentists, real estate), restaurants, boutique retailers.\nCost-conscious owners who don't want to fund a King West agency to build a 8-page website.",
  },
  {
    location: 'Vaughan / Woodbridge',
    fit:
      "Heart of the Italian-Canadian business community.\nConstruction, retail, food and beverage, real estate, professional services run by Italian-Canadian families.\nBilingual content + cultural fit + EU rates = obvious match.",
  },
  {
    location: 'Mississauga',
    fit:
      "South Asian + Italian + diverse business community.\nManufacturing, logistics, B2B services, professional firms.\nMulti-language sites are the norm; I handle EN/IT, coordinate other languages with translators.",
  },
  {
    location: 'Markham',
    fit:
      "Tech-adjacent businesses, professional services, multicultural retail.\nModern stack expectations (Next.js, headless CMS, JAMstack) — exactly what I ship.",
  },
  {
    location: 'Brampton + Hamilton',
    fit:
      "Trades, contractors, manufacturing, retail, growing professional services.\nOften underserved by Toronto agencies who price themselves out — better fit for European freelance rates.",
  },
];

const COMMON_PROJECTS = [
  {
    title: 'Restaurants and food businesses',
    body:
      "Bilingual menu (EN/IT often), online reservations, takeout/delivery integration (Uber Eats, SkipTheDishes via API), Google Business Profile optimization for local search, basic e-commerce for prepared foods or specialty items.",
  },
  {
    title: 'Construction and trades',
    body:
      "Portfolio of completed projects with proper galleries, service areas mapped to GTA municipalities, lead generation forms with project type / budget pre-qualification, Google Business Profile + reviews.\nWCAG-compliant for municipal contract eligibility.",
  },
  {
    title: 'Professional services (legal, accounting, real estate)',
    body:
      "Trust-first design (no template look), structured service pages, team bios with credentials, secure contact / intake forms (PIPEDA-compliant), Italian-language version for clients who prefer Italian.",
  },
  {
    title: 'Specialty retail and e-commerce',
    body:
      "Shopify or custom (Next.js + Stripe Canada), product catalog with proper search, multi-currency CAD/USD, Canada Post shipping integration, GDPR + PIPEDA-compliant cookie + analytics setup.",
  },
];

const FAQS = [
  {
    q: "I'm in Vaughan and looking at agencies in Woodbridge — why pick someone in Italy?",
    a: "Two reasons: cost and code quality.\nLocal Vaughan agencies often markup heavily for the convenience factor (you can drop by).\n\nFor most projects, you don't need to drop by — you need someone who returns emails, ships on time, and writes code that doesn't fall apart in 18 months.\nI'm 6 hours ahead, available your morning every day, bilingual, and rates are typically half what a Woodbridge mid-tier agency charges.",
  },
  {
    q: 'My business serves the Italian-Canadian community. Does that change anything?',
    a: "Yes, in good ways.\nI write Italian natively, English fluently — your bilingual site reads naturally in both languages.\n\nI understand cultural nuances (formal vs informal address, regional Italian expressions, holiday calendar that includes Italian holidays).\nFor businesses where word-of-mouth in the community matters more than Google ads, building something that 'feels right' to Italian-Canadian customers actually drives referrals.",
  },
  {
    q: 'What about local SEO? Will Google find my Vaughan / Toronto business?',
    a: "Yes.\nLocal SEO setup is part of any project: Google Business Profile optimization, schema markup with local business + GeoCoordinates, local citations (Yellow Pages Canada, Yelp Canada, industry directories), reviews strategy.\n\nFor GTA businesses I prioritize: 'service near me' searches, suburb-specific landing pages where it makes sense (Vaughan, Mississauga, Markham, etc.), and Google Maps integration.\nPIPEDA-compliant analytics so you can measure what works.",
  },
  {
    q: 'Can I meet you in person?',
    a: "Honest answer: I visit Vaughan when I'm in Canada (family there).\nFor active projects, in-person meetings aren't necessary — video calls + good async communication cover everything.\n\nIf face-to-face is critical for your decision-making, I can recommend Toronto-based partners I trust.\nBut before doing that, consider that 90% of successful client relationships I've had over 8+ years have been entirely remote.",
  },
  {
    q: 'How do you handle Canadian payment processors?',
    a: "Stripe Canada is the default for most projects (CAD support, Interac, real Canadian payouts).\nFor specific use cases: Moneris for legacy retail integration, Helcim for lower fees on small businesses, Square for in-person + online combo.\nI integrate whatever fits your operation.\nNever lock you into a processor I get a kickback from — there is no kickback.",
  },
  {
    q: "What's the time difference reality day-to-day?",
    a: "Italy is 6 hours ahead of Eastern Time.\nMy working day starts when yours has 2 hours left (8 AM Italy = 2 AM Toronto — I don't reach out then).\n\nReal overlap window: 14:00-17:00 ET (= 20:00-23:00 CET).\nThat's three solid hours of synchronous availability per day.\n\nFor everything else, async on Slack/Linear/email — typical reply within your morning the next business day.\nFor genuine emergencies, retainer SLA covers 24h regardless of time zone.",
  },
  {
    q: 'Do you work in French for Quebec-adjacent businesses?',
    a: "I don't write French natively, so for French-first content I work with a Quebec-based French copywriter (I have a couple I trust for technical and marketing content).\nThe site infrastructure handles French/English/Italian i18n natively — you don't pay extra for language switching, only for translation work itself.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'gta-fit', number: '01', label: 'Why GTA businesses pick this' },
  { id: 'audiences', number: '02', label: '5 GTA submarkets' },
  { id: 'projects', number: '03', label: 'Common GTA projects' },
  { id: 'community', number: '04', label: 'Italian-Canadian fit' },
  { id: 'logistics', number: '05', label: 'How GTA work works' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function FreelanceWebDesignerTorontoGTAPage() {
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'Freelance Web Designer & Developer for the GTA',
            description:
              'Italy-based freelance web designer & developer for Greater Toronto Area businesses. Bilingual EN/IT, EU-quality, CAD-friendly rates.',
            url: '/en/freelance-web-designer-toronto-gta',
            section: 'Freelance Services',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Freelance Web Designer Canada', url: '/en/freelance-web-designer-canada' },
            { name: 'Freelance Web Designer GTA', url: '/en/freelance-web-designer-toronto-gta' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Freelance Web Designer Canada', url: '/en/freelance-web-designer-canada' },
          { name: 'GTA', url: '/en/freelance-web-designer-toronto-gta' },
        ]}
        eyebrow="GTA-specific — 6 chapters · 6 min read"
        title="Freelance Web Designer & Developer for the Greater Toronto Area. Toronto, Vaughan, Mississauga, Markham, Brampton, Hamilton."
        lead={
          <>
            For GTA small businesses and the Italian-Canadian community across Woodbridge, Vaughan,
            Mississauga and beyond.\nEU-quality engineering, English and Italian, CAD-friendly rates,
            and yes — I have family in Vaughan, which is part of why this market matters to me.
          </>
        }
        chapters={CHAPTERS}
        readTime="6 min"
        updatedAt="May 8, 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — GTA fit */}
        <section id="gta-fit" className="mb-20 md:mb-28 scroll-mt-32">
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
            01 — Why this works for GTA businesses
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            The GTA is the most expensive web design market in Canada.\nToronto agencies charge
            New York rates because they can.\nMost GTA small businesses don't actually need a Toronto
            agency — they need someone who builds well, ships on time, and doesn't bill them for
            office rent on King Street.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            European freelance solves the cost problem without the offshore drawbacks.\nYou get EU
            engineering quality, English-fluent communication (Italian fluent too — useful in Vaughan
            and parts of Toronto), workable time zone (6h ahead), GDPR-native compliance that maps
            cleanly onto PIPEDA + Quebec Law 25.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            And specifically for GTA: there's a 1.5M-strong Italian-Canadian community concentrated
            here.\nIf your business serves part of that community, building with someone who actually
            speaks the language and understands the culture is a competitive edge that's hard to
            replicate.
          </p>
        </section>

        {/* Cap 02 — Audiences */}
        <section id="audiences" className="mb-20 md:mb-28 scroll-mt-32">
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
            02 — 5 GTA submarkets and what fits
          </p>
          <ul className="flex flex-col">
            {GTA_AUDIENCES.map((a, i) => (
              <li
                key={i}
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
                    {a.location}
                  </h3>
                </div>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {a.fit}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Projects */}
        <section id="projects" className="mb-20 md:mb-28 scroll-mt-32">
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
            03 — Common GTA project types
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {COMMON_PROJECTS.map((p, i) => (
              <li
                key={i}
                className="flex flex-col gap-4 p-6 md:p-8"
                style={{ border: '1px solid var(--color-line)' }}
              >
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.25rem, 1.8vw, 1.5rem)',
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
            04 — Italian-Canadian community fit (Vaughan especially)
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Vaughan and Woodbridge host one of the largest Italian-Canadian populations outside
            Italy.\nMany local businesses — restaurants, contractors, importers, retailers,
            professional services — have customers and operations that move between English and
            Italian.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>What changes with a native Italian developer:</strong> bilingual content reads
            naturally in both languages (no machine-translated awkwardness), regional cultural cues
            land properly (formal vs informal, traditional vs modern), Italian customer-facing
            sections feel authentic instead of token.\nFor businesses that compete on community trust,
            this is real differentiation.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Practical disclosure:</strong> I have family in Vaughan.\nThat's why I started
            building for the Canadian market in the first place — small business owners I know
            there were paying Toronto agency rates for sites that didn't even respect their bilingual
            audience properly.\nThe economics didn't make sense, and the community fit was missing.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Italian holidays in calendars, Italian phone formats in contact forms, lira/euro
            historical context where relevant for older customers, proper accent handling in
            Italian names (Mariangela vs Mariangela, Catanìa vs Catania) — small details that
            machine translation and Toronto-only agencies routinely miss.
          </p>
        </section>

        {/* Cap 05 — Logistics */}
        <section id="logistics" className="mb-20 md:mb-28 scroll-mt-32">
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
            05 — How working with a GTA business across the Atlantic actually works
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[65ch] whitespace-pre-line text-justify">
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Discovery call (30 min, free).</strong> Best slots: 13:00-17:00 ET your time
              (that's 19:00-23:00 my time, productive evening hours for me).\nFor Italian-Canadian
              clients who prefer Italian: call in Italian, switch to English for technical bits.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Scope + CAD pricing.</strong> Within 3 working days.\nInvoiced in CAD
              (or USD if you prefer) via wire transfer or Wise/Revolut.\nNo hidden FX fees, clear
              line-item breakdown.\nPayment terms: 50% upfront, 50% on delivery for fixed projects.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Async + weekly sync.</strong> Slack or email for daily updates (your morning =
              my afternoon = real-time).\nWeekly 30-min video sync at a time that works for both,
              usually Tuesday afternoon ET.\nProject board on Linear or Notion you can check anytime.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Pre-launch QA + Canadian compliance.</strong> Performance, accessibility,
              browser/device testing, PIPEDA + Quebec Law 25 review (if relevant).\nSchema.org local
              business markup for GTA, Google Business Profile linking, Maps embed for storefront.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Launch + ongoing.</strong> Code repo, hosting, domain — all yours.\nCan host on
              Canadian-region cloud (AWS Canada Central / Cloudflare GTA POP) for data residency.\nOptional retainer for monitoring, security, content updates.\nFor genuinely critical
              issues: 24h SLA regardless of time zone.
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
            06 — FAQs (GTA-specific)
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
                <div className="flex flex-col gap-4 max-w-[80ch]">
                  {f.a.split('\n\n').map((para, j) => (
                    <p
                      key={j}
                      className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                      style={{ color: 'var(--color-ink-muted)' }}
                    >
                      {para}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </EditorialArticleLayout>
    </>
  );
}
