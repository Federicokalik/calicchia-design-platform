import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';

interface LaScintillaProps {
  index?: string;
  /** Override the eyebrow text (otherwise translated default is used). */
  eyebrow?: string;
}

const WORKFLOW_KEYS = ['direzione', 'progetto', 'produzione'] as const;
const CAPABILITY_KEYS = [
  'websites',
  'ecommerce',
  'landing',
  'seo',
  'branding',
  'uiux',
  'marketing',
  'maintenance',
] as const;

export async function LaScintilla({
  index = '02',
  eyebrow,
}: LaScintillaProps = {}) {
  const t = await getTranslations('perche.laScintilla');

  const eyebrowText = eyebrow ?? t('eyebrowDefault');

  const workflow = WORKFLOW_KEYS.map((key) => ({
    key,
    label: t(`workflow.${key}.label`),
    description: t(`workflow.${key}.description`),
  }));

  const capabilities = CAPABILITY_KEYS.map((key) => ({
    key,
    label: t(`capabilities.${key}`),
  }));

  return (
    <Section id="la-scintilla" spacing="compact" bordered="top">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-12">
        <div className="lg:col-span-4">
          <p
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.24em]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {index} - {eyebrowText}
          </p>
          <h2
            className="mt-7 font-[family-name:var(--font-display)] max-w-[11ch]"
            style={{
              fontSize: 'clamp(2.5rem, 4vw + 0.5rem, 4.75rem)',
              fontWeight: 500,
              letterSpacing: '-0.03em',
              lineHeight: 0.98,
            }}
          >
            {t('h2')}
          </h2>
        </div>

        <div className="lg:col-span-8">
          <p
            className="text-2xl md:text-3xl leading-snug max-w-[30ch]"
            style={{
              color: 'var(--color-ink)',
              letterSpacing: '-0.012em',
            }}
          >
            {t('lead')}
          </p>

          <div
            className="mt-12 divide-y"
            style={{ borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
          >
            {workflow.map((item, idx) => (
              <div key={item.key} className="grid grid-cols-1 md:grid-cols-[8rem_1fr] gap-4 py-6">
                <span
                  className="font-mono text-xs uppercase tracking-[0.18em]"
                  style={{ color: 'var(--color-ink-subtle)' }}
                >
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <div className="grid grid-cols-1 md:grid-cols-[12rem_1fr] gap-3 md:gap-8">
                  <h3 className="text-sm font-medium uppercase tracking-[0.16em]">{item.label}</h3>
                  <p className="text-base leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    {item.description}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <ul className="mt-8 flex flex-wrap gap-2">
            {capabilities.map((item) => (
              <li
                key={item.key}
                className="border px-3 py-2 text-xs uppercase tracking-[0.14em]"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
