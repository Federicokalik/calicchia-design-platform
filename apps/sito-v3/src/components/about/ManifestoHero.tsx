interface ManifestoHeroProps {
  eyebrow: string;
  title: string;
  intro: string;
}

export function ManifestoHero({ eyebrow, title, intro }: ManifestoHeroProps) {
  return (
    <section
      className="relative px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-24 md:pb-32 max-w-[1600px] mx-auto"
    >
      <div className="flex items-baseline justify-between gap-6 mb-12">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          01 — {eyebrow}
        </p>
      </div>

      <h1
        className="font-[family-name:var(--font-display)] mb-12 max-w-[16ch]"
        style={{
          fontSize: 'var(--text-display-xl)',
          fontWeight: 500,
          letterSpacing: '-0.035em',
          lineHeight: 0.9,
        }}
      >
        {title}
      </h1>

      <p
        className="text-xl md:text-2xl leading-relaxed max-w-[55ch]"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {intro}
      </p>
    </section>
  );
}
