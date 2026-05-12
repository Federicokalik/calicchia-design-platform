import { compileMjml } from './_compile';

const SITE_URL = process.env.SITE_URL || 'https://calicchia.design';

interface LayoutInput {
  /** Email-client preview text (visible in inbox preview, max ~90 chars). */
  preview: string;
  /** `aria-label` / screen reader title for the email. */
  title: string;
  /** Inner MJML — must be a sequence of `<mj-section>` elements (no nesting). */
  sectionsMjml: string;
  /** Locale label for accessibility (`lang` attr). */
  lang?: 'it' | 'en';
}

/**
 * Build the full MJML document with the shared Calicchia brand wrapper:
 *
 *   - Warm off-white background (#FAFAF7), ink #111, accent #F57F44
 *   - Funnel Display/Sans web fonts with system fallback
 *   - Squared corners, hairline borders, NO shadow (Pentagram-aligned)
 *   - Header wordmark + footer with privacy link
 *   - Compatible Outlook 2013+, Gmail/web/mobile, Apple Mail, iOS Mail
 *
 * Caller provides `sectionsMjml` which is one or more `<mj-section>` blocks
 * (no `<mj-body>` wrapper, no head — handled here).
 */
export async function renderBrandedEmail(input: LayoutInput): Promise<{ html: string; text: string }> {
  const { preview, title, sectionsMjml, lang = 'it' } = input;

  const mjml = `<mjml lang="${lang}">
  <mj-head>
    <mj-title>${title}</mj-title>
    <mj-preview>${preview}</mj-preview>
    <mj-font name="Funnel Sans" href="https://fonts.googleapis.com/css2?family=Funnel+Sans:wght@400;500;700&display=swap" />
    <mj-font name="Funnel Display" href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@500;600&display=swap" />
    <mj-attributes>
      <mj-all font-family="Funnel Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif" />
      <mj-text color="#111111" font-size="14px" line-height="22px" />
      <mj-button background-color="#F57F44" color="#FFFFFF" font-weight="500" border-radius="2px" inner-padding="12px 24px" font-size="14px" />
      <mj-section background-color="#FAFAF7" padding="0" />
      <mj-class name="card" background-color="#FFFFFF" border="1px solid #E6E4DC" padding="32px 32px" />
      <mj-class name="muted" color="#5C5C58" font-size="12px" line-height="18px" />
      <mj-class name="eyebrow" color="#8C8C86" font-size="11px" letter-spacing="2px" text-transform="uppercase" />
      <mj-class name="display" font-family="Funnel Display, Funnel Sans, Georgia, serif" font-weight="500" font-size="22px" line-height="28px" color="#111111" letter-spacing="-0.01em" />
    </mj-attributes>
    <mj-style inline="inline">
      a { color: #111111; text-decoration: underline; }
      a.brand { color: #F57F44; }
    </mj-style>
  </mj-head>
  <mj-body background-color="#FAFAF7" width="560px">
    <mj-section padding="24px 24px 8px">
      <mj-column>
        <mj-text mj-class="eyebrow" align="left">Calicchia Design</mj-text>
      </mj-column>
    </mj-section>

    ${sectionsMjml}

    <mj-section padding="16px 24px 32px">
      <mj-column>
        <mj-text mj-class="muted" align="center">
          <a href="${SITE_URL}" class="brand">calicchia.design</a>
          &nbsp;·&nbsp;
          <a href="${SITE_URL}/privacy-policy">Privacy</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

  return compileMjml(mjml);
}
