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
      'Freelance Web Designer & Developer based in Italy · For European, UK and US clients | Federico Calicchia',
  },
  description:
    "Italy-based freelance web designer & developer working in English. Websites, e-commerce, custom development, SEO, WordPress. EU+UK+US clients. One contact, no agency middlemen, EU timezone.",
  alternates: { canonical: '/en/freelance-web-designer-italy' },
  openGraph: {
    title: 'Freelance Web Designer & Developer based in Italy',
    description:
      "Italy-based, working in English. EU+UK+US clients. One contact, no agency middlemen, EU timezone.",
    url: '/en/freelance-web-designer-italy',
    locale: 'en_US',
  },
};

const ADVANTAGES = [
  {
    n: '01',
    title: 'EU rates, EU quality',
    body:
      "Italian freelance rates are competitive vs UK/US/Northern Europe agency fees, while keeping the same engineering quality.\nYou're not buying offshore: you're buying EU-based, GDPR-native, English-speaking, time-zone-overlapping engineering — at a price point that doesn't require a Series A to afford.",
  },
  {
    n: '02',
    title: 'Same time zone (mostly)',
    body:
      'Italy is in CET/CEST.\nOverlap with UK is 1 hour off, with EU 0-1h, with US East coast 6h, with US West coast 9h.\nFor most calls and async work, the timezone math is much friendlier than India, Philippines, or Eastern Europe alternatives.\nReal-time collaboration, not next-day handoffs.',
  },
  {
    n: '03',
    title: 'GDPR-native by default',
    body:
      "Italy is in the EU.\nEvery project I ship is GDPR-compliant out of the box: cookie consent done right, data processing agreements in place, privacy policy that holds up to actual regulators.\nNo retrofitting compliance after launch — it's baked in.",
  },
  {
    n: '04',
    title: 'One person, full stack',
    body:
      "Design, frontend, backend, hosting, SEO, performance, accessibility — same hands.\nNo internal hand-offs, no project manager forwarding emails, no 'that's not in my scope'.\nYou get one contact, one invoice, one source of accountability.",
  },
];

const COMPARISON_ROWS = [
  {
    label: 'Cost vs UK/US agency',
    italy:
      'Significantly lower hourly/project rates while maintaining EU engineering standards.\nNo agency overhead (account managers, offices in Soho, layered margins).',
    other:
      'UK/US agencies routinely 2-4x the equivalent IT freelance rate, with much of the cost going to non-billable infrastructure.',
  },
  {
    label: 'Time zone',
    italy:
      'CET/CEST.\nSame business hours as EU clients, 1h off UK, 6-9h US (manageable with morning/evening calls).',
    other:
      'India/Philippines: 3.5-7h off EU, 8-12h off US.\nMeans async-only, slower iteration.',
  },
  {
    label: 'Communication',
    italy:
      "Native Italian, fluent professional English.\nComfortable in calls, written briefs, async tools (Slack, Linear, Notion).\nDirect, no hierarchy theater.",
    other:
      'Offshore providers often layer through account managers; cultural communication norms can introduce friction (over-promising, lack of pushback).',
  },
  {
    label: 'Code quality & ownership',
    italy:
      'Modern stack (Next.js, React, TypeScript, Tailwind, headless CMS).\nYou own the code, hosting, domain, credentials.',
    other:
      'Mixed.\nSome offshore providers use proprietary frameworks or vendor lock-in.\nQuality varies wildly between firms.',
  },
  {
    label: 'Legal / contracts',
    italy:
      "EU contract law, GDPR compliance, formal Italian VAT-registered freelance.\nReal legal recourse if needed.",
    other:
      'Variable.\nCross-border legal recourse for offshore providers is often theoretical, not practical.',
  },
];

const FAQS = [
  {
    q: 'Why pick an Italy-based freelancer over a UK or US agency?',
    a: "Cost-to-quality ratio.\nItaly has world-class design schools (Polimi, IUAV, NABA) and a strong engineering tradition; rates are competitive vs UK/US agencies while keeping EU quality and GDPR compliance.\nYou skip the agency overhead entirely.\nFor projects under £50k / $60k it's almost always the better economic choice.",
  },
  {
    q: 'Why pick an Italy-based freelancer over offshore (India, Philippines, Eastern Europe)?',
    a: 'Time zone overlap with EU/UK is much smaller (0-1h vs 3-7h), communication is direct without account-manager layers, code quality is more predictable, and EU legal framework gives real recourse if anything goes wrong.\nYou also get GDPR-native compliance, which matters if you sell to EU consumers.',
  },
  {
    q: "Do you work in English? How fluent?",
    a: "Yes, fluently.\nI work in English daily with EU and UK clients.\nWritten briefs, video calls, async messaging on Slack/Linear/Notion — all in English without friction.\nMy Italian-language work is for IT clients; everything else is in English.",
  },
  {
    q: 'How does payment work for non-Italian clients?',
    a: "I'm VAT-registered in Italy (P.IVA 03160480608).\nWithin EU: reverse-charge invoicing (no VAT, you handle in your country).\nUK/US/non-EU: invoices in EUR or USD (your preference), wire transfer or Wise/Revolut.\nPayment terms typically 50% upfront / 50% on delivery for one-shot projects, monthly for retainers.",
  },
  {
    q: 'Can you handle hosting and ongoing maintenance from abroad?',
    a: 'Yes.\nHosting and DNS are managed via Cloudflare, Vercel, AWS, or whatever the project requires — all cloud-based, location-agnostic.\nMaintenance retainer covers updates, security patches, monitoring, and urgent fixes within 24h regardless of where the client is based.',
  },
  {
    q: 'What about data residency and GDPR for non-EU clients?',
    a: "If your customers are in the EU/UK/Switzerland, GDPR applies regardless of where your business is based.\nI default to EU-region hosting (Frankfurt, Paris, Milan), GDPR-compliant analytics setup, and consent management out of the box.\nFor US-only audiences, we can use US-region hosting if you prefer.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'why-italy', number: '01', label: 'Why pick Italy-based' },
  { id: 'advantages', number: '02', label: '4 concrete advantages' },
  { id: 'comparison', number: '03', label: 'Italy vs alternatives' },
  { id: 'projects', number: '04', label: 'What I build' },
  { id: 'how-it-works', number: '05', label: 'How working with me works' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function FreelanceWebDesignerItalyPage() {
  // EN-only page. Block IT (return 404) — il content è in inglese nativo,
  // tradurre a IT non avrebbe senso (audience target = clienti EU/UK/US).
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'Freelance Web Designer & Developer based in Italy',
            description:
              'Italy-based freelance web designer & developer working in English. EU+UK+US clients.',
            url: '/en/freelance-web-designer-italy',
            section: 'Freelance Services',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Freelance Web Designer Italy', url: '/en/freelance-web-designer-italy' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Freelance Web Designer Italy', url: '/en/freelance-web-designer-italy' },
        ]}
        eyebrow="Positioning — 6 chapters · 7 min read"
        title="Freelance Web Designer & Developer based in Italy. Working in English with European, UK and US clients."
        lead={
          <>
            One person, full stack, EU-based.\nModern engineering quality at competitive
            European rates, GDPR-native, no agency middlemen, no offshore friction.\nItalian by
            location, English by default in business.
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
            01 — Why pick an Italy-based freelancer
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            You're considering hiring outside your country because local agencies cost too much
            or your local talent pool is thin.\nThe two obvious alternatives — UK/US boutique
            agencies or offshore providers — both have well-known problems.
          </p>
          <p
            className="text-base md:text-lg leading-relaxed mb-4 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Boutique agencies</strong> are expensive: you pay for offices in central
            London or NYC, account managers who don't write code, project managers forwarding
            your emails to the actual designer.\nMargin on top of margin.\nFor projects under
            £50k / $60k the math doesn't add up.
          </p>
          <p
            className="text-base md:text-lg leading-relaxed mb-4 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Offshore providers</strong> (India, Philippines, parts of Eastern Europe)
            are cheap upfront but expensive in friction: 3-7 hour timezone gaps mean async-only
            collaboration, cultural communication norms can hide problems until launch, code
            quality varies wildly, and cross-border legal recourse is theoretical.
          </p>
          <p
            className="text-base md:text-lg leading-relaxed max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Italy-based freelance is the middle ground:</strong> EU-quality engineering,
            GDPR-native, time zone overlap with EU/UK, fluent English, EU contract law — at
            rates that are typically half what a UK/US agency would charge for the same work.
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
            03 — Italy-based vs the alternatives
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
                    UK/US agency or offshore
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

        {/* Cap 04 — Projects */}
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
            04 — What I build
          </p>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Eleven services, one standard. Most projects are a combination of these:
          </p>
          <ul className="flex flex-col gap-3 max-w-[65ch] list-disc pl-6 whitespace-pre-line text-justify">
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Web design + development</strong> — bespoke websites and landing pages,
              not templates.\nModern stack (Next.js, React, TypeScript, Tailwind, headless CMS).
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>E-commerce</strong> — Shopify, WooCommerce, custom builds.\nStripe / PayPal
              integration, EU+UK+US tax compliance, multi-currency.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Custom development</strong> — internal tools, dashboards, client portals,
              API integrations, custom CMS.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Performance & Core Web Vitals</strong> — LCP / CLS / INP optimization,
              passing Google's check, measurable before/after.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Accessibility (WCAG 2.1 AA)</strong> — EU Accessibility Act compliance,
              screen reader testing, real audits (not widgets).
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>SEO & Analytics</strong> — technical SEO, schema markup, GA4 + GTM,
              Consent Mode v2, Looker Studio dashboards.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>WordPress (the unfun parts)</strong> — security hardening, malware
              cleanup, performance tuning, zero-downtime migrations.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Branding</strong> — logo system, type scale, brand guidelines (digital-first).
            </li>
          </ul>
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
            05 — How working with me works
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[65ch] whitespace-pre-line text-justify">
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>30-minute discovery call.</strong> Free.\nWe figure out if it makes sense
              to work together.\nI'll ask about goals, timeline, what already exists, what
              you've tried.\nNo PowerPoint pitch.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Written scope and proposal.</strong> Within 3 working days.\nFixed-scope
              project or hourly retainer, your call.\nEverything in writing — no surprise
              extras mid-project.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Design & build, weekly check-ins.</strong> Async updates on Slack/Linear,
              weekly 30-min sync video.\nYou see progress every week, can course-correct anytime.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Pre-launch QA.</strong> Performance audit, accessibility check, browser
              testing, GDPR review.\nNot "we hope it works" — verified.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Launch + handoff.</strong> Code repository, hosting credentials,
              documentation.\nYou own everything from day one.\nOptional maintenance retainer
              if you want me to keep monitoring and updating.
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
