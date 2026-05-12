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
      'Website Design for Italian Restaurants · Bilingual Menu, Reservations, Built by an Italian | Federico Calicchia',
  },
  description:
    "Website design and development for Italian restaurants in North America: trattorie, pizzerie, panetterie, gelaterie. Bilingual menus EN/IT, online reservations, takeout integration, Google Business Profile optimization. Built by a native Italian.",
  alternates: { canonical: '/en/italian-restaurants-website-design' },
  openGraph: {
    title: 'Website Design for Italian Restaurants',
    description:
      "Bilingual menus, reservations, takeout APIs, Google Maps optimization. Built by a native Italian, no fake-Italian theme-park aesthetic.",
    url: '/en/italian-restaurants-website-design',
    locale: 'en_CA',
  },
};

const ESSENTIAL_FEATURES = [
  {
    n: '01',
    title: 'Bilingual menu (Italian + English)',
    body:
      "Menu items in Italian read naturally for Italian-speaking customers and signal authenticity to English-speakers.\n'Tagliatelle al ragù alla bolognese' beats 'Bolognese pasta'.\nSchema-marked for Google Maps, printable PDF version, downloadable nutritional info if needed for chain compliance.\nUpdates on your end without calling me.",
  },
  {
    n: '02',
    title: 'Online reservations (real ones)',
    body:
      "OpenTable / Resy / Tock integration for established markets.\nOr custom system if you prefer to own the data and avoid commission fees ($1-2 per cover adds up fast on a 100-cover Saturday).\nCalendar sync with your POS.\nSMS confirmation.\nNo-show protection.\nWalk-in tracking integration optional.",
  },
  {
    n: '03',
    title: 'Takeout & delivery — yours, not theirs',
    body:
      "Direct-order page that customers can use instead of Uber Eats or SkipTheDishes.\nYou keep the full margin (less Stripe fees) instead of paying 30% to delivery aggregators.\nToast/Square integration for kitchen tickets.\nOr pure pickup-only if you don't deliver.\nAggregator integration too if it makes sense — but always with your direct option visible first.",
  },
  {
    n: '04',
    title: 'Google Business Profile optimization',
    body:
      "Most local restaurant traffic comes from Google Maps, not from organic search.\nGBP optimization includes: bilingual description (English + Italian), proper category (Italian restaurant + sub-categories like trattoria/pizzeria), photo strategy (food, exterior, interior, staff, every season), reviews response strategy in both languages, posts cadence integrated with your social media.",
  },
  {
    n: '05',
    title: "Stories that don't sound like ChatGPT",
    body:
      "Family history page that reads like a real family wrote it (because someone real wrote it).\nRegional roots (Calabria? Friuli? Sicilia? Trentino?) called out specifically when it adds value.\nRecipes inherited, ingredient sourcing, supplier relationships — the things that actually make Italian restaurants different from each other.\nNo 'we use the freshest ingredients' boilerplate.",
  },
  {
    n: '06',
    title: 'Speed that holds up on Saturday night',
    body:
      "Friday and Saturday evening, every Italian restaurant in the GTA gets traffic spikes from 'pizzeria near me' and similar.\nSite needs to load in <2.5s on mobile (Core Web Vitals: LCP green) or you lose customers to the next listing.\nImage optimization, font loading, caching CDN — all configured.\nNo agency-built site that breaks under load.",
  },
];

const COMMON_MISTAKES = [
  {
    n: '01',
    label: 'Italian flag colors as the primary palette',
    why: "Authentic Italian restaurants in Italy almost never use red-white-green.\nThat's how Italian-themed franchises in mall food courts brand themselves.\nReal Italian design uses muted, regional palettes: terracotta + cream for southern, slate + cream for northern, deep red for Bolognese, etc.\nColor signals authenticity or theme-park immediately.",
  },
  {
    n: '02',
    label: '"La Dolce Vita" / "Buon Appetito" hero taglines',
    why: "Theme-park signal.\nReal Italian restaurants don't quote tourist-Italian phrases at customers.\nThey serve good food and let the food speak.\nSite copy should reflect that: factual, regional, specific.\nNot phrasebook.",
  },
  {
    n: '03',
    label: 'Stock photos of pasta-on-checkered-tablecloth',
    why: "Every Italian-themed business in North America uses these.\nCustomers immediately register 'fake'.\nReal photography of your actual restaurant — even from a phone, even imperfect — beats generic stock 100% of the time.\nPlan a 2-hour shoot day during quiet hours, get 50 usable photos, done.",
  },
  {
    n: '04',
    label: 'Menu PDFs that need 5 minutes to load',
    why: "Restaurants frequently host their menu as a 8MB PDF (scanned from print).\nMobile users on cellular data abandon it.\nSolution: HTML menu (loads instantly, indexable for SEO, screen-reader accessible) + downloadable PDF as alternative for those who want to print.",
  },
  {
    n: '05',
    label: 'No phone number above the fold mobile',
    why: "60-80% of restaurant traffic on Saturdays is mobile users searching for 'Italian restaurant near me' to call for a table.\nIf your phone number isn't tap-to-call in the top 100px of mobile screen, you're losing them to whoever's listing has it.",
  },
];

const FAQS = [
  {
    q: 'Do I need an Italian-speaking developer for an Italian restaurant website?',
    a: "Practically helpful, not strictly necessary.\nThe benefit comes through in menu translation quality (machine-translated dish names sound stilted), regional descriptions that feel authentic vs touristy, customer-facing copy that doesn't read like a tourist phrasebook.\n\nFor a restaurant where the Italian heritage is part of the marketing pitch (which is 95% of Italian restaurants in North America), this matters a lot.\nFor a fast-casual chain that happens to serve pasta, less so.",
  },
  {
    q: 'OpenTable vs Resy vs custom reservation system?',
    a: "Honest breakdown: OpenTable has the largest customer base but charges per cover and locks you into their ecosystem.\nResy is more design-friendly, similar pricing, smaller customer base in Canada.\n\nCustom reservation system (built into your site) gives you 100% margin and customer data ownership but requires marketing effort to drive bookings since customers default to OpenTable.\nMy usual recommendation: OpenTable for visibility + custom for repeat customers, optional.\nDiscuss based on your actual booking volume.",
  },
  {
    q: 'How important is Instagram / TikTok for restaurants in 2026?',
    a: "Very important for discovery, especially for younger demographics.\nThe website's job isn't to compete with social — it's to convert social-media-discovered traffic into reservations and orders.\nOpen Graph optimization so shared menu items look right on Instagram, embedded Reels on the home page where appropriate, schema markup that makes Google show your restaurant in 'visual search' results when someone searches food images.",
  },
  {
    q: 'Can you handle e-commerce for selling sauces / olive oil / specialty foods online?',
    a: "Yes.\nStripe Canada or Shopify (depending on volume and stack preference).\nFor Italian restaurants that sell shelf-stable specialty items, online store can be a solid revenue stream — especially during off-peak seasons or for capturing customers who travel.\nShipping integration with Canada Post / UPS, tax calculation for cross-province sales, GST/HST handling automatic.",
  },
  {
    q: 'My restaurant is in a tourist area, do you handle multi-language beyond English/Italian?',
    a: "Yes, infrastructure-wise.\nThe site i18n architecture supports any language.\nFor French (Quebec, ski-resort towns), I work with Quebec-based French copywriters.\nFor German, Spanish, Mandarin: same pattern, you bring the translator (or I help you find one), the system handles it.\n\nCommon combos for Italian restaurants in tourist areas: EN + IT + FR (Quebec / Vermont border / ski areas), EN + IT + DE (Niagara wine region for German tourists), EN + IT + ZH (Toronto Chinatown adjacent neighborhoods).",
  },
  {
    q: 'How do you handle holiday menus and seasonal updates?',
    a: "CMS structure that lets you add seasonal menus, special tasting nights, holiday offerings without calling me.\nChristmas / Natale and Easter / Pasqua have specific menus for most Italian restaurants.\nThe CMS supports scheduled publish (set the new menu to go live at 6am Tuesday), dual-language editing in one form, image uploads with auto-resize.\nFor visual changes (banner art, hero photo seasonal), you ping me and it's done same week.",
  },
  {
    q: 'What about delivery aggregator commissions and the math?',
    a: "Real numbers: Uber Eats / SkipTheDishes typically charge 25-35% commission.\nOn a $30 dinner order, the restaurant nets ~$19-22 instead of $30 if customer ordered direct.\n\nDirect ordering through your own site costs Stripe fees (~2.9% + 30¢) — so $29.10 net on the same order.\nFor a busy restaurant doing 50 delivery orders a day, the difference is $300-400/day in margin.\n\nDirect ordering page pays for itself in weeks if you have enough customers.\nAggregators still useful for discovery, but always link your direct option first.",
  },
];

const CHAPTERS: EditorialChapterEntry[] = [
  { id: 'why-italian', number: '01', label: 'Why an Italian developer for Italian restaurants' },
  { id: 'features', number: '02', label: '6 essential features' },
  { id: 'mistakes', number: '03', label: '5 common mistakes' },
  { id: 'aggregators', number: '04', label: 'Aggregators vs direct ordering' },
  { id: 'community', number: '05', label: 'Italian-Canadian community fit' },
  { id: 'faqs', number: '06', label: 'FAQs' },
];

export default async function ItalianRestaurantsWebsitePage() {
  const locale = await getLocale();
  if (locale !== 'en') notFound();

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: 'Website Design for Italian Restaurants',
            description:
              'Bilingual menus, reservations, takeout APIs, Google Maps optimization for Italian restaurants in North America.',
            url: '/en/italian-restaurants-website-design',
            section: 'Restaurant Websites',
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/en' },
            { name: 'Italian Businesses Toronto', url: '/en/italian-businesses-toronto-website-design' },
            { name: 'Italian Restaurants', url: '/en/italian-restaurants-website-design' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/en' },
          { name: 'Italian Businesses Toronto', url: '/en/italian-businesses-toronto-website-design' },
          { name: 'Italian Restaurants', url: '/en/italian-restaurants-website-design' },
        ]}
        eyebrow="Vertical — Restaurants — 6 chapters · 7 min read"
        title="Website design for Italian restaurants. Real menus, real reservations, no fake-Italian theme park."
        lead={
          <>
            For trattorie, pizzerie, panetterie, gelaterie, ristoranti and osterie across the GTA,
            New York, Boston, Chicago and beyond.\nBilingual menus done right, reservations that
            don't lose covers, takeout that doesn't bleed margin to aggregators, Google Maps
            optimization that actually wins.\nBuilt by a native Italian who's eaten in real Italian
            restaurants on both sides of the Atlantic.
          </>
        }
        chapters={CHAPTERS}
        readTime="7 min"
        updatedAt="May 8, 2026"
        showFinalCta={true}
      >
        {/* Cap 01 — Why */}
        <section id="why-italian" className="mb-20 md:mb-28 scroll-mt-32">
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
            01 — Why an Italian developer makes a difference for Italian restaurants
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Italian restaurants compete on authenticity.\nCustomers — both Italian-Canadian and
            non-Italian — can sense when a restaurant is "real" vs "Italian-themed".\nThe website
            is part of that signal, often the first impression.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            Toronto-area Italian restaurants are routinely served by web agencies that build the
            same template for every "ethnic" restaurant: red-white-green, "Mamma Mia", stock pasta
            photos, faux-handwritten fonts.\nIt looks like Olive Garden marketing.\nCustomers
            register that as "this is a tourist trap" within three seconds of landing on the homepage.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>The fix isn't subtle, it's just rare:</strong> design that actually looks
            modern Italian (Pentagram-tier editorial, not theme-park), copy that reads like an
            Italian wrote it, regional context where it adds depth (Calabrese vs Toscano vs
            Siciliano have different culinary identities), photography of your actual food and
            space instead of stock.\nI do all of this because I'm Italian and I care about the
            distinction.
          </p>
        </section>

        {/* Cap 02 — Features */}
        <section id="features" className="mb-20 md:mb-28 scroll-mt-32">
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
            02 — 6 essential features for Italian restaurant websites
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {ESSENTIAL_FEATURES.map((f) => (
              <li
                key={f.n}
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
                  {f.n} — Feature
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.25rem, 1.8vw, 1.5rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}
                >
                  {f.title}
                </h3>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {f.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Mistakes */}
        <section id="mistakes" className="mb-20 md:mb-28 scroll-mt-32">
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
            03 — 5 common mistakes that signal "tourist trap"
          </p>
          <ul className="flex flex-col">
            {COMMON_MISTAKES.map((m, i) => (
              <li
                key={m.n}
                className="grid grid-cols-1 md:grid-cols-[80px_1fr_2fr] gap-4 md:gap-8 py-6"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: '0.18em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {m.n}
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                    fontWeight: 500,
                    lineHeight: 1.2,
                  }}
                >
                  {m.label}
                </h3>
                <p
                  className="text-base leading-relaxed"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {m.why}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 04 — Aggregators */}
        <section id="aggregators" className="mb-20 md:mb-28 scroll-mt-32">
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
            04 — Aggregators (Uber Eats / SkipTheDishes) vs direct ordering
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Most Italian restaurants in North America have surrendered ~30% of their delivery
            margin to aggregators because direct ordering setup feels too complicated.\nIt's not
            complicated, and the math is decisive.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Uber Eats / SkipTheDishes typically charge 25-35% commission</strong> on each
            order.\nOn a $30 dinner: restaurant nets ~$19-22 instead of $30.\nThe aggregator handles
            delivery, customer support, and discovery — that's worth something, but it's worth
            10-15%, not 30%.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>Direct ordering on your own site</strong> costs Stripe Canada fees (~2.9% +
            30¢): same $30 order nets $29.10.\nDifference is $7-10 per order.\nFor a restaurant
            doing 50 delivery orders a day, that's $350-500/day in margin recovery — about
            $10k-15k/month.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>The realistic strategy:</strong> keep aggregators for discovery (new customers
            find you on Uber Eats first), but every aggregator listing links back to your site.\nExisting customers see "Order direct, save 25%" prominently on the site and on the
            aggregator description.\nWithin 6-12 months, repeat customers shift to direct, and you
            keep margin instead of feeding it to an aggregator.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            For delivery itself, options vary: own driver (lowest cost if volume justifies it),
            DoorDash Drive (use their drivers for direct orders, ~$8/order flat), or no delivery /
            pickup-only (best margins, but limits market).\nDiscuss based on your geography and
            volume.
          </p>
        </section>

        {/* Cap 05 — Community */}
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
            05 — Italian-Canadian community fit (especially Vaughan + Toronto)
          </p>
          <p
            className="body-longform text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            For Italian restaurants in Vaughan, Woodbridge, Toronto and the broader GTA, the
            customer base is partly Italian-Canadian (community trust matters, word-of-mouth
            dominates) and partly non-Italian (looking for "authentic Italian" experience).\nDifferent audiences, same restaurant — the website needs to land for both.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            For Italian-Canadian customers: bilingual content done well (Italian sections that
            read naturally, regional sensitivity if your roots are specific — Calabrese,
            Siciliano, Friulano), family/heritage stories that feel real, schedule for Italian
            holidays (Ferragosto, Festa della Repubblica, regional patron saints).
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            For non-Italian customers: anti-cliché design that signals "this is real" instead of
            "this is themed", menu descriptions that educate without condescending, regional
            context that adds depth without becoming a lecture.
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            <strong>I have family in Vaughan.</strong> Practical effect: I understand
            Italian-Canadian restaurant culture from the customer side, work in your time zone
            window for hours every day, and care about the difference between the real version
            and the Olive-Garden-tier version of Italian-American restaurant marketing.
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
