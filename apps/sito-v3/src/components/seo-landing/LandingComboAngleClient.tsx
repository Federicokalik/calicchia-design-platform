import { Section } from '@/components/ui/Section';

interface LandingComboAngleClientProps {
  intro: string;
  angle: string;
  index: string;
  eyebrow: string;
}

export function LandingComboAngleClient({
  intro,
  angle,
  index,
  eyebrow,
}: LandingComboAngleClientProps) {
  return (
    <Section spacing="compact" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-12">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrow}
        </p>
      </div>
      <div>
        <p
          className="font-[family-name:var(--font-display)] mb-8 max-w-[28ch] whitespace-pre-line"
          style={{
            fontSize: 'clamp(1.75rem, 3vw, 2.75rem)',
            fontWeight: 500,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
          }}
        >
          {intro}
        </p>
        <p
          className="text-lg md:text-xl leading-relaxed max-w-[60ch] whitespace-pre-line"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {angle}
        </p>
      </div>
    </Section>
  );
}
