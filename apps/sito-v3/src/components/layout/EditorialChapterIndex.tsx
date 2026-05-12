'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MonoLabel } from '@/components/ui/MonoLabel';

export type EditorialChapterEntry = {
  id: string;
  number: string;
  label: string;
};

export type EditorialChapterIndexVariant = 'numbered' | 'alphabet';

interface EditorialChapterIndexProps {
  chapters: EditorialChapterEntry[];
  variant?: EditorialChapterIndexVariant;
  ariaLabel?: string;
}

export function EditorialChapterIndex({
  chapters,
  variant = 'numbered',
  ariaLabel = 'Indice dei capitoli',
}: EditorialChapterIndexProps) {
  const [activeId, setActiveId] = useState<string>(chapters[0]?.id ?? '');
  const [mobileOpen, setMobileOpen] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: '-30% 0% -55% 0%',
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );

    chapters.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    observerRef.current = observer;
    return () => observer.disconnect();
  }, [chapters]);

  const onClick = useCallback(
    (id: string, evt: React.MouseEvent<HTMLAnchorElement>) => {
      const target = document.getElementById(id);
      if (!target) return;
      evt.preventDefault();

      const lenis =
        typeof window !== 'undefined'
          ? (window as unknown as { __lenis?: { scrollTo(t: HTMLElement, o?: { offset?: number }): void } }).__lenis
          : undefined;

      if (lenis?.scrollTo) {
        lenis.scrollTo(target, { offset: -96 });
      } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      history.replaceState(null, '', `#${id}`);
      setActiveId(id);
      setMobileOpen(false);
    },
    []
  );

  const activeChapter = chapters.find((c) => c.id === activeId) ?? chapters[0];

  return (
    <>
      {/* Desktop: static rail (Swiss compliance: no sticky in public site) */}
      <nav aria-label={ariaLabel} className="hidden md:block">
        <MonoLabel as="p" className="mb-6 uppercase tracking-[0.2em]">
          {variant === 'alphabet' ? 'Alfabeto' : 'Capitoli'}
        </MonoLabel>
        <ol role="list" className="flex flex-col">
          {chapters.map((chapter) => {
            const isActive = chapter.id === activeId;
            return (
              <li
                key={chapter.id}
                className="border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <a
                  href={`#${chapter.id}`}
                  onClick={(e) => onClick(chapter.id, e)}
                  aria-current={isActive ? 'location' : undefined}
                  className={`group flex items-baseline gap-3 py-3 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    isActive ? 'font-medium' : 'font-normal'
                  }`}
                  style={{
                    color: isActive
                      ? 'var(--color-text-primary)'
                      : 'var(--color-text-secondary)',
                    fontFamily: 'var(--font-sans)',
                    fontSize: '0.875rem',
                    lineHeight: 1.3,
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-mono-xs)',
                      letterSpacing: '0.05em',
                      color: isActive
                        ? 'var(--color-accent-deep)'
                        : 'var(--color-text-tertiary)',
                      width: '1.75rem',
                    }}
                  >
                    {chapter.number}
                  </span>
                  <span className="flex-1">{chapter.label}</span>
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      style={{
                        color: 'var(--color-accent)',
                        fontSize: '0.75rem',
                        lineHeight: 1,
                      }}
                    >
                      ●
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Mobile: static dropdown at top of article (Swiss compliance: no sticky) */}
      <div
        className="md:hidden -mx-6 px-6 border-y"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-controls="editorial-chapter-list-mobile"
          className="w-full flex items-baseline justify-between gap-3 py-3 text-left"
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-mono-xs)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--color-text-secondary)',
            }}
          >
            {activeChapter ? `${activeChapter.number} · ${activeChapter.label}` : 'Indice'}
          </span>
          <span
            aria-hidden="true"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-mono-xs)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            {mobileOpen ? '— chiudi' : '+ apri'}
          </span>
        </button>
        {mobileOpen ? (
          <ol
            id="editorial-chapter-list-mobile"
            role="list"
            className="pb-4 flex flex-col"
          >
            {chapters.map((chapter) => {
              const isActive = chapter.id === activeId;
              return (
                <li
                  key={chapter.id}
                  className="border-t"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <a
                    href={`#${chapter.id}`}
                    onClick={(e) => onClick(chapter.id, e)}
                    aria-current={isActive ? 'location' : undefined}
                    className={`flex items-baseline gap-3 py-3 ${
                      isActive ? 'font-medium' : 'font-normal'
                    }`}
                    style={{
                      color: isActive
                        ? 'var(--color-text-primary)'
                        : 'var(--color-text-secondary)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: '0.875rem',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        letterSpacing: '0.05em',
                        color: isActive
                          ? 'var(--color-accent-deep)'
                          : 'var(--color-text-tertiary)',
                        width: '1.75rem',
                      }}
                    >
                      {chapter.number}
                    </span>
                    <span>{chapter.label}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </>
  );
}
