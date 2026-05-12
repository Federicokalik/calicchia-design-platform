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
      'Website Design for Italian Businesses in Toronto + GTA · Bilingual EN/IT, Built by Italian, EU-Quality | Federico Calicchia',
  },
  description:
    "Website design and development for Italian-Canadian businesses in Toronto, Vaughan, Woodbridge, Mississauga, Hamilton. Native Italian speaker, EU engineering, CAD-friendly rates. Restaurants, contractors, retailers, professionals.",
  alternates: { canonical: '/en/italian-businesses-toronto-website-design' },
  openGraph: {
    title: 'Website Design for Italian Businesses in Toronto + GTA',
    description:
      'Bilingual EN/IT, native Italian speaker, EU engineering quality, CAD rates. For Italian-Canadian businesses across the GTA.',
    url: '/en/italian-businesses-toronto-website-design',
    locale: 'en_CA',
  },
};

const TYPICAL_CLIENTS = [
  {
    sector: 'Restaurants & food businesses',
    detail:
      "Trattorie, pizzerie, panetterie, gelaterie, alimentari, importers, catering.\nMost have menus and customer-facing content that's natural in Italian (specialty names, regional dishes, family history) and need to communicate in both languages without sounding translated.",
    examples: 'Trattoria, pizzeria, panetteria, gelateria, alimentari, catering, importers',
  },
  {
    sector: 'Construction & trades',
    detail:
      "Concentrated in Vaughan / Woodbridge / King City.\nGeneral contractors, masons, tilers, framers, custom home builders, landscapers, demolition.\nOften family-run multi-generation businesses with deep community roots.",
    examples: 'General contractors, masons, framers, custom home builders, landscapers',
  },
  {
    sector: 'Professional services',
    detail:
      "Italian-Canadian lawyers, accountants, real estate agents, mortgage brokers, dentists, doctors, therapists, financial advisors.\nTrust-first audience, often serving both Italian-speaking and English-speaking clients.",
    examples: 'Lawyers, accountants, real estate agents, doctors, dentists, financial advisors',
  },
  {
    sector: 'Specialty retail',
    detail:
      "Fashion boutiques, jewelers, home goods, kitchen / bath suppliers, flower shops, tobacconists, religious goods.\nOften importing from Italy, with bilingual customer base.",
    examples: 'Fashion boutiques, jewelers, kitchen suppliers, flower shops, religious goods',
  },
  {
    sector: 'Cultural & community organizations',
    detail:
      "Italian cultural centers, sports clubs (calcio leagues, bocce clubs), churches with Italian congregations, regional associations (Calabresi, Siciliani, Friulani, etc), language schools.",
    examples: 'Cultural centers, sports clubs, parish associations, language schools',
  },
];

const COMMON_PROBLEMS = [
  {
    n: '01',
    title: 'Sites that sound machine-translated',
    body:
      "Toronto agencies that 'do bilingual' often run Italian copy through Google Translate or hire a junior.\nResult: stilted Italian, wrong formal/informal register, regional dialect inconsistencies.\nItalian-Canadian customers spot it immediately and lose trust.\nWorse: the English version often has Italian-flavored mistakes too (calques, wrong prepositions) because the same translator handled both directions.",
  },
  {
    n: '02',
    title: 'Generic templates with cypress-tree clichés',
    body:
      "Italian restaurant template #47: red-white-green color scheme, Tuscan landscape stock photo, faux-handwritten 'la dolce vita' tagline, italianate font that no one in Italy actually uses.\nIt signals 'fake Italian' to anyone with actual exposure.\nReal Italian-Canadian customers recognize the difference between authentic and theme-park Italian.",
  },
  {
    n: '03',
    title: 'Wrong character handling for Italian names',
    body:
      "Form fields that strip accents (Cataniá → Catania), customer databases that can't store é/à/ù, email systems that mangle subject lines with diacritics.\nFor Italian-Canadian businesses with customers named D'Angelo, Capecè, Greco-Bisacchi, this is a daily annoyance that signals 'not built for us'.",
  },
  {
    n: '04',
    title: 'Missing cultural cues in date/time/contact',
    body:
      "Phone format (06 vs 416), date format (24 dicembre vs December 24), holiday calendar that ignores Ferragosto / Festa della Repubblica / Italian regional saints' days important for events and bookings.\nAddress format that doesn't handle 'Via Italia 27' alongside '27 Italia Way'.\nSmall details, cumulative effect.",
  },
];

const FAQS = [
  {
    q: "Why does it matter that you're actually Italian, not just 'Italian-friendly'?",
    a: "Because Italian-Canadian customers can tell the difference within 30 seconds of reading bilingual copy.\nNative-quality Italian writing (correct register, regional sensitivity, idiom that doesn't sound like a textbook) is hard to fake.\n\nFor businesses that compete partly on community trust — and most Italian-Canadian businesses do — this is real differentiation.\n\nIt's also pragmatic: I write your Italian copy myself, no translator middleman, no 'I'll get back to you when I hear from the Italian guy' delays.",
  },
  {
    q: 'Do most Italian-Canadian businesses actually need bilingual sites?',
    a: "Depends on the business.\nRestaurants and food: yes, usually (menu items in Italian feel right, regional descriptions help upselling specialty items, older Italian-speaking customers appreciate it).\n\nContractors: optional, often the customer base speaks English but the trust factor of Italian-language version helps with referrals.\nProfessional services: variable — depends on whether you serve older Italian-speaking clients or 2nd/3rd generation English-only.\n\nI help you decide based on your real audience, not assumed culture.",
  },
  {
    q: "I'm a 3rd-generation Italian-Canadian who doesn't speak Italian. Does this still apply?",
    a: "Yes, in different ways.\nThe cultural fit isn't only language — it's understanding family-business dynamics (multi-generation involvement, Saturday-morning espresso decision-making, supplier relationships that span decades).\nFor 2nd/3rd generation owners, often the site needs to honor heritage without alienating non-Italian customers.\nI help thread that needle: heritage cues that resonate without becoming a theme park.",
  },
  {
    q: 'How do I know your work is actually good for Italian-Canadian audiences?',
    a: "You can ask for case studies during the discovery call (specific examples under client confidentiality).\nThe portfolio on /lavori shows shipped work with verifiable results.\nThe /en/freelance-web-designer-canada and /en/freelance-web-designer-toronto-gta pages explain the broader positioning.\nAnd: I have family in Vaughan, which is where this market focus comes from.",
  },
  {
    q: 'Can you help with Google Maps optimization for our storefront?',
    a: "Yes.\nGoogle Business Profile setup and optimization is part of any local-business project.\nFor Italian-Canadian businesses I pay attention to: bilingual business descriptions (English primary, Italian secondary in description), photo strategy (food, exterior, interior, staff), reviews response strategy in both languages, integration with the website for booking/menu/contact.\nItalian language in Google Business Profile actually helps for searches like 'pizzeria italiana Vaughan'.",
  },
  {
    q: 'What about TikTok / Instagram strategy for Italian-Canadian businesses?',
    a: "I don't manage social media (out of scope), but the website integrates cleanly with whoever does.\nFor restaurants and retail especially: schema markup that pulls into Instagram links, Open Graph optimization for shared posts, embedded reels/posts where appropriate.\nMany Italian-Canadian restaurants in Toronto are doing well on TikTok specifically — the website should support that traffic, not compete with it.",
  },
  {
    q: 'Will Italian customers in Italy be able to find us through this site?',
    a: "If they're searching for you specifically (your business name), yes.\nFor broader 'Italian-X-in-Canada' searches from Italy: depends on your category.\nRestaurants get organic Italian-tourism searches ('best Italian restaurant Toronto Italians'), specialty importers get diaspora-trade searches.\nArchitecture is the same as any local SEO — bilingual content helps for both diaspora-Italian and tourist-Italian queries.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'why-this', number: '01', label: 'Why this exists' },
  { id: 'clients', number: '02', label: '5 typical client types' },
  { id: 'problems', number: '03', label: '4 problems with Toronto-agency sites' },
  { id: 'approach', number: '04', label: 'How I build differently' },
  { id: 'vaughan', number: '05', label: 'Vaughan / Woodbridge specifically' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function ItalianBusinessesTorontoPage() {
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'Website Design for Italian Businesses in Toronto + GTA',
            description:
              'Bilingual EN/IT website design for Italian-Canadian businesses in Toronto, Vaughan, Woodbridge, Mississauga.',
            url: '/en/italian-businesses-toronto-website-design',
            section: 'Freelance Services',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Freelance Web Designer Canada', url: '/en/freelance-web-designer-canada' },
            {
              name: 'Italian Businesses Toronto',
              url: '/en/italian-businesses-toronto-website-design',
            },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Freelance Web Designer Canada', url: '/en/freelance-web-designer-canada' },
          { name: 'Italian Businesses Toronto', url: '/en/italian-businesses-toronto-website-design' },
        ]}
        eyebrow="Vertical positioning — 6 chapters · 7 min read"
        title="Website design for Italian businesses in Toronto and the GTA. Built by an actual Italian, in two languages."
        lead={
          <>
            For restaurants, contractors, professional firms, retailers and cultural organizations
            run by Italian-Canadians across Toronto, Vaughan, Woodbridge, Mississauga, Hamilton and
            beyond.\nBilingual EN/IT done by a native Italian speaker, EU-quality engineering,
            CAD-friendly rates, no agency middlemen pretending to "do Italian."
          </>
        }
        chapters={CHAPTERS}
        readTime="7 min"
        updatedAt="May 8, 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Why */}
        <section id="why-this" className="mb-20 md:mb-28 scroll-mt-32">
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
            01 — Why this page exists
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            About 1.5 million Canadians have Italian heritage.\nThe community is thickest in the
            Greater Toronto Area — Vaughan and Woodbridge especially — followed by Hamilton,
            Montreal, and Vancouver.\nA lot of small to mid-sized businesses in those areas are
            Italian-owned, often family-run, often multi-generational.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Most of those businesses get their websites built by Toronto agencies that don't really
            understand the audience, or by random offshore freelancers who copy-paste templates.\nThe result is a market full of sites that look the same, sound generic, and miss the
            cultural cues that actually matter for Italian-Canadian customers.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>I'm Italian.\nI have family in Vaughan.\nI build websites for a living.</strong>{' '}
            That combination isn't unique, but it's rare in this market — and it lets me build
            sites for Italian-Canadian businesses that don't feel like they were made for "any
            ethnic restaurant" by someone who's never been to a real trattoria.
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
            02 — 5 typical Italian-Canadian client types
          </p>
          <ul className="flex flex-col">
            {TYPICAL_CLIENTS.map((c, i) => (
              <li
                key={c.sector}
                className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-4 md:gap-12 py-8"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <div className="flex flex-col gap-3">
                  <h3
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.25rem, 1.8vw, 1.5rem)',
                      fontWeight: 500,
                      lineHeight: 1.2,
                    }}
                  >
                    {c.sector}
                  </h3>
                  <span
                    className="font-mono text-[11px] uppercase tracking-[0.18em]"
                    style={{ color: 'var(--color-accent-deep)' }}
                  >
                    {c.examples}
                  </span>
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
            03 — 4 problems with Toronto-agency sites for Italian businesses
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
            04 — How I build differently
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Specific differences when I build for Italian-Canadian businesses, not just generic
            "ethnic-business" templates:
          </p>
          <ul className="flex flex-col gap-4 max-w-[80ch] list-disc pl-6 mb-4 whitespace-pre-line text-justify">
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Native Italian copy.</strong> I write the Italian content myself — correct
              register (formal lei vs informal tu, depending on context), regional sensitivity
              (Calabrese restaurants don't sound the same as Friulani imports), idioms that don't
              feel translated.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Anti-cliché visual design.</strong> No red-white-green flag dividers, no
              tossed-spaghetti hero shots, no fake-handwritten "Mamma Mia" taglines.\nModern Italian
              design (Pentagram-tier, Swiss-influenced, editorial typography) — which is what
              actual Italian brands look like in 2026.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Proper character handling.</strong> Forms, databases, email templates
              configured for é, à, ù, è, ò, ì from day one.\nCustomer names with apostrophes
              (D'Angelo, D'Amico) handled correctly through the entire system.\nNo 'unsupported
              character' errors months later.
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Cultural cues in functional details.</strong> Italian holidays in
              calendars/availability, Italian phone format support alongside Canadian, address
              format that handles Italian-style 'Via Roma 27' for diaspora-trade businesses,
              language switcher that's first-class (not buried in a flag in the footer).
            </li>
            <li className="text-base md:text-lg leading-relaxed" style={{ color: 'var(--color-ink)' }}>
              <strong>Direct relationship.</strong> No account manager translating between you and
              the Italian-speaking team in another country.\nYou email me, I reply.\nIf your
              parents/partners want to discuss something in Italian over the phone, that's how the
              call goes.
            </li>
          </ul>
        </section>

        {/* Cap 05 — Vaughan */}
        <section id="vaughan" className="mb-20 md:mb-28 scroll-mt-32">
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
            05 — Vaughan / Woodbridge specifically
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Vaughan and Woodbridge form the densest concentration of Italian-Canadians in North
            America.\nItalian is spoken in homes, businesses, parishes, sports clubs.\nThe local
            economy has a strong bilingual undercurrent that doesn't exist anywhere else in Canada
            at the same density.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            For Vaughan-area businesses I pay attention to: <strong>local SEO that targets
            both 'Italian-X Vaughan' and 'X Vaughan'</strong> queries (different audiences, same
            business, both worth ranking for); <strong>Google Business Profile in both
            languages</strong>; <strong>schema markup for local business with Italian
            subcategory</strong> where it makes sense (Italian restaurant, Italian bakery, Italian
            grocery).
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            The community runs on word of mouth and Google Maps reviews.\nSite → Maps profile →
            reviews → site loop is critical.\nFor restaurants and retail this is often more
            important than paid ads.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Disclosure:</strong> I have family in Vaughan.\nThat's why this market is in my
            focus and why I take it seriously.\nIt's not a marketing line — it's the reason I
            understand the business culture from the inside.
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
                <div className="flex flex-col gap-4">
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
