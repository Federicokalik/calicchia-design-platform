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
      'Italian Web Designer & Developer for European B2B Businesses · EU-Quality, EU-Rates, GDPR-Native | Federico Calicchia',
  },
  description:
    "Italy-based freelance web designer & developer for European B2B mid-market companies. EU-quality engineering, GDPR-native, EUR / GBP invoicing, modern stack (Next.js / React / TypeScript). For SaaS, manufacturing, professional services, agencies needing reliable EU partner.",
  alternates: { canonical: '/en/italian-web-designer-for-european-business' },
  openGraph: {
    title: 'Italian Web Designer for European B2B Businesses',
    description:
      'EU-quality, EU-rates, GDPR-native. For SaaS, manufacturing, professional services, agencies needing reliable EU partner.',
    url: '/en/italian-web-designer-for-european-business',
    locale: 'en_GB',
  },
};

const TARGET_BUSINESSES = [
  {
    label: 'European B2B SaaS companies',
    detail:
      "Mid-market SaaS based in Germany, Netherlands, France, Sweden serving EU customers.\nNeed marketing site + product docs + customer dashboard + GDPR-compliant analytics + multi-language support.\nModern stack expectations (Next.js, headless CMS, Vercel/Cloudflare deployment).",
  },
  {
    label: 'European manufacturing & B2B services',
    detail:
      "German Mittelstand, French ETI, Italian PMI, UK SMEs in industrial / professional services / B2B logistics.\nNeed sites that handle long sales cycles, technical product specs, multi-language EU markets, B2B forms with proper qualification, integration with Salesforce / HubSpot / Pipedrive CRM.",
  },
  {
    label: 'EU agencies needing white-label development',
    detail:
      "Boutique design agencies in London, Berlin, Amsterdam who land big clients but lack senior developers in-house.\nStandard freelance engagement: I work as their dev partner, they keep client relationship + project management.\nNative English, EU contract law, EU-region timezone.",
  },
  {
    label: 'European e-commerce expanding multi-country',
    detail:
      "Mid-market DTC brands with operations in 3-5 EU countries.\nNeed Shopify Plus or custom e-commerce with multi-currency, multi-language, country-specific tax (VAT OSS), localized checkout, integration with European fulfillment partners.",
  },
];

const ADVANTAGES = [
  {
    n: '01',
    title: 'EU contract law + GDPR-native',
    body:
      "Italy is in the EU, so contracts are EU jurisdiction (no offshore legal recourse problems).\nGDPR is the default privacy framework — every project ships GDPR-compliant from day one, not retrofitted before launch.\nFor B2B EU clients with strict procurement, this matters: legal can sign off without a 6-week review.",
  },
  {
    n: '02',
    title: 'Modern stack as default',
    body:
      "Next.js 15+, React 19, TypeScript, Tailwind, headless CMS (Sanity / Contentful / Strapi), Vercel / Cloudflare / AWS.\nNo legacy WordPress unless you specifically request it.\nBuild pipeline ready for 2026 standards (Core Web Vitals green, accessibility WCAG AA, SEO baseline competitive).",
  },
  {
    n: '03',
    title: 'EU-rates, EU-quality',
    body:
      "Italian freelance rates run lower than UK / DE / NL / SE freelance rates (varies by 30-50% depending on market).\nQuality is comparable — Italian engineering schools (Polimi, IUAV, Bologna) produce strong technical graduates.\nThe arbitrage is real and not based on cutting corners.",
  },
  {
    n: '04',
    title: 'Time zone overlap with EU + UK',
    body:
      "CET/CEST is the same time zone as Berlin, Paris, Amsterdam, Madrid (or 1 hour off UK GMT/BST).\nSynchronous calls anytime in normal business hours.\nAsync tools cover the rest.\nCompared to offshore providers (3-7h gap), iteration speed is dramatically faster.",
  },
];

const VS_COMPARISON = [
  {
    label: 'Hourly / project rate',
    italy:
      'Significantly below typical UK/DE/NL freelance rates (varies 30-50% by market).\nBelow Polish/Romanian senior rates too.',
    other:
      'UK senior freelance: £75-150/hr typical.\nDE: €80-130/hr.\nNL: €90-140/hr.\nSE: SEK 800-1500/hr.\nUK/EU agencies: 2-3x freelance rates.',
  },
  {
    label: 'Time zone',
    italy:
      'CET/CEST = same as DE/FR/NL/ES, 1h off UK.\nReal-time overlap during all business hours.',
    other:
      'UK/DE/NL/SE freelance: same TZ as you.\nIndia: 3.5-4.5h ahead.\nEastern EU: 1h ahead, fine.\nUS: 6-9h behind, async-only typically.',
  },
  {
    label: 'Language',
    italy:
      'Native Italian, fluent professional English.\nTechnical English in code reviews / docs / specs.',
    other:
      'UK/EU freelance: native English (or your local language) + business English.\nOffshore: variable English; some excellent, some communication friction.',
  },
  {
    label: 'Legal framework',
    italy:
      'EU contract law.\nGDPR jurisdiction.\nItalian VAT-registered (P.IVA).\nReal legal recourse via EU courts if needed.',
    other:
      'UK freelance post-Brexit: UK law (still recoverable but extra friction for EU contracts).\nOffshore: variable, often theoretical legal recourse cross-border.',
  },
  {
    label: 'Procurement-ready',
    italy:
      'EU-jurisdiction contracts, IBAN accounts, VAT compliance, proper invoicing for EU vendor onboarding.\nLegal-clean for B2B procurement.',
    other:
      'UK/EU freelance: similarly clean.\nOffshore: often requires extra documentation, sometimes blocked by procurement on principle.',
  },
];

const FAQS = [
  {
    q: 'Why hire from Italy instead of UK/DE/NL freelance market?',
    a: "Cost.\nItalian freelance rates run 30-50% below the equivalent UK / DE / NL senior freelance rates with comparable engineering quality.\n\nFor a 6-month project budget that would cover a UK senior at £80k, you can get the same shipping velocity from Italian freelance for substantially less.\n\nThe UK / DE / NL freelance markets are saturated with high-rate seniors; Italy has equivalent talent at lower price points because the local market normalizes lower.",
  },
  {
    q: "Why hire from Italy instead of Eastern Europe (Poland, Romania, Ukraine)?",
    a: "Eastern European rates are similar to or slightly below Italian rates, so cost isn't the differentiator.\n\nThe differentiators: (1) EU jurisdiction without complications (Ukraine isn't in EU; Romania has occasional EU friction), (2) cultural design sensibility — Italian design heritage is recognized internationally, while Eastern European agencies sometimes struggle with brand positioning at premium tier.\n\n(3) Language + business culture overlap with Western Europe is closer for Italian than for Eastern European providers.",
  },
  {
    q: "How does payment work for B2B European clients?",
    a: "I'm VAT-registered in Italy (P.IVA 03160480608).\nFor EU B2B clients with VAT number: reverse-charge invoicing (you handle VAT in your country, I issue invoice without IVA).\n\nFor UK clients: invoices in GBP via wire transfer or Wise.\nFor non-EU: standard professional invoice in EUR/USD/GBP.\n\nPayment terms typically Net 30 for established companies, Net 15 / 50% upfront for new relationships.",
  },
  {
    q: 'Do you sign NDAs and standard B2B contracts?',
    a: "Yes.\nStandard EU NDA, mutual confidentiality, IP assignment to client on payment, non-compete only when reasonable.\nFor larger engagements (€20k+) usually a Master Services Agreement + Statement of Work per project.\nI can work from your contract template (preferred for procurement-heavy companies) or supply mine.",
  },
  {
    q: 'Can you work directly with our internal dev team?',
    a: "Yes, often the best engagement type for mid-market companies.\nI act as senior dev / consultant, your team handles the rest.\n\nPair on architecture, ship critical features I can deliver faster, code review for quality, document for handoff.\nStandard tools: Slack/Linear/Notion/GitHub.\n\nDaily standup via Slack thread, weekly video sync.\nNo 'agency abstraction layer' — I'm just one more senior on your team for the engagement duration.",
  },
  {
    q: "What about data residency for EU customers' data?",
    a: "Default: EU-region hosting (AWS Frankfurt / Paris / Milan, Cloudflare with European POPs, Vercel EU regions).\n\nFor maximum strict data residency (German BSI, French SecNumCloud, regulated industries): I can deploy on European-only providers (OVHcloud, Scaleway, Hetzner) with documentation suitable for compliance audits.\n\nCosts slightly more for performance but covers strict procurement requirements.",
  },
  {
    q: 'Are you available for retainer engagements vs only project-based?',
    a: "Yes, retainer is often the better fit for B2B European clients.\nStandard packages: 20h/month (small fixes + updates), 40h/month (active development on a defined product area), 80h/month (effectively a part-time senior on your team).\n\nRetainer hours don't roll over indefinitely (fair-use 2 months max), unused hours can convert to additional fixed-scope deliverables.\nDiscuss based on your roadmap.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'why', number: '01', label: 'Why this positioning' },
  { id: 'targets', number: '02', label: '4 target business types' },
  { id: 'advantages', number: '03', label: '4 EU advantages' },
  { id: 'comparison', number: '04', label: 'Italy vs other EU vs offshore' },
  { id: 'engagements', number: '05', label: 'Engagement types' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function ItalianWebDesignerForEuropeanBusinessPage() {
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'Italian Web Designer & Developer for European B2B Businesses',
            description:
              "EU-quality engineering, EU-rates, GDPR-native. For SaaS, manufacturing, professional services, agencies needing reliable EU partner.",
            url: '/en/italian-web-designer-for-european-business',
            section: 'Freelance Services',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Freelance Web Designer Italy', url: '/en/freelance-web-designer-italy' },
            {
              name: 'Italian Web Designer for European Business',
              url: '/en/italian-web-designer-for-european-business',
            },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Freelance Web Designer Italy', url: '/en/freelance-web-designer-italy' },
          {
            name: 'For European Business',
            url: '/en/italian-web-designer-for-european-business',
          },
        ]}
        eyebrow="B2B EU positioning — 6 chapters · 6 min read"
        title="Italian web designer & developer for European B2B businesses. EU-quality, EU-rates, GDPR-native by default."
        lead={
          <>
            For mid-market European companies — SaaS, manufacturing, B2B services, agencies — that
            need reliable engineering at competitive European rates without UK/DE/NL pricing or
            offshore communication friction.\nEU contract law, GDPR-native, modern stack default.
          </>
        }
        chapters={CHAPTERS}
        readTime="6 min"
        updatedAt="May 8, 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Why */}
        <section id="why" className="mb-20 md:mb-28 scroll-mt-32">
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
            01 — Why this positioning exists
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            European mid-market businesses have three options for web development: hire local
            (expensive in UK / DE / NL / SE), hire offshore (communication friction + legal
            recourse problems), or hire from elsewhere in Europe at competitive rates with EU
            framework intact.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Italian freelance is the third option done well.\nSame EU regulatory environment as your
            local freelance market, similar engineering quality, but priced 30-50% lower because
            the Italian domestic freelance market normalizes lower rates.\nThis is arbitrage, but
            it's not based on cutting corners — it's based on different cost-of-living and
            different market norms.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            The page exists for procurement teams, CTOs, and founders evaluating freelance
            engineering for European projects.\nIf you're already paying UK / DE / NL senior
            freelance rates and want to know what changes if you hire from Italy instead — this
            covers it.
          </p>
        </section>

        {/* Cap 02 — Targets */}
        <section id="targets" className="mb-20 md:mb-28 scroll-mt-32">
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
            02 — 4 target business types
          </p>
          <ul className="flex flex-col">
            {TARGET_BUSINESSES.map((t, i) => (
              <li
                key={t.label}
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
                    {t.label}
                  </h3>
                </div>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {t.detail}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Advantages */}
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
            03 — 4 EU advantages over offshore
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
                    fontSize: 'clamp(1.25rem, 1.8vw, 1.625rem)',
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

        {/* Cap 04 — Comparison */}
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
            04 — Italy vs other EU freelance vs offshore
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
                    UK/DE/NL freelance or offshore
                  </th>
                </tr>
              </thead>
              <tbody>
                {VS_COMPARISON.map((r, i) => (
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

        {/* Cap 05 — Engagements */}
        <section id="engagements" className="mb-20 md:mb-28 scroll-mt-32">
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
            05 — Engagement types for B2B European clients
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[80ch]">
            <li className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Fixed-scope project.</strong> Marketing site, product page, e-commerce build,
              custom dashboard.\nDiscovery call → written scope → 50% upfront / 50% on delivery.\nTypical timeline 4-12 weeks.\nBest fit for clearly-bounded deliverables.
            </li>
            <li className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Monthly retainer.</strong> 20h / 40h / 80h per month.\nBest fit for ongoing
              product development, regular feature shipping, mature companies with continuous
              roadmap.\nHours don't roll over indefinitely (fair-use 2 months max), unused hours can
              convert to additional fixed-scope work.
            </li>
            <li className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Senior-on-team augmentation.</strong> I act as one more senior on your team
              for the engagement duration (3-12 months).\nPair on architecture, ship features,
              review code, document for handoff.\nNo agency abstraction layer.\nStandard tools
              (Slack / Linear / GitHub).
            </li>
            <li className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>White-label for agencies.</strong> EU agencies that land big clients but lack
              senior dev capacity.\nI work as their dev partner, they keep client relationship.\nStandard freelance NDA, output looks like agency output, communication via agency PM.
            </li>
            <li className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
              <strong>Audit + advisory.</strong> Code review, architecture review, performance
              audit, accessibility audit.\nBest fit for companies with internal team that want
              senior outside perspective without long engagement.\n1-3 weeks fixed scope.
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
                <div className="flex flex-col gap-4 max-w-[80ch]">
                  {f.a.split('\n\n').map((para, idx) => (
                    <p
                      key={idx}
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
