import type { CSSProperties, ReactNode } from 'react';
import { Eyebrow } from './Eyebrow';
import { Heading, type HeadingProps } from './Heading';

type Align = 'start' | 'center';
type TitleSize = NonNullable<HeadingProps['size']>;
type TitleTag = NonNullable<HeadingProps['as']>;

export interface SectionHeaderProps {
  eyebrow?: ReactNode;
  eyebrowMono?: boolean;
  title: ReactNode;
  titleAs?: TitleTag;
  titleSize?: TitleSize;
  titleMaxWidth?: string;
  description?: ReactNode;
  align?: Align;
  className?: string;
  style?: CSSProperties;
}

/**
 * Section header — eyebrow + display title + optional lead description.
 * Replaces the ad-hoc combination seen across ~12 components where each
 * file repeats <p>EYEBROW</p><h2 style={{ fontSize: ... }}>...
 */
export function SectionHeader({
  eyebrow,
  eyebrowMono = false,
  title,
  titleAs = 'h2',
  titleSize = 'display-md',
  titleMaxWidth,
  description,
  align = 'start',
  className = '',
  style,
}: SectionHeaderProps) {
  const wrapperCls = [
    'flex flex-col gap-6',
    align === 'center' ? 'items-center text-center' : 'items-start',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const titleStyle: CSSProperties | undefined = titleMaxWidth
    ? { maxWidth: titleMaxWidth }
    : undefined;

  return (
    <header className={wrapperCls} style={style}>
      {eyebrow && <Eyebrow mono={eyebrowMono}>{eyebrow}</Eyebrow>}
      <Heading as={titleAs} size={titleSize} style={titleStyle}>
        {title}
      </Heading>
      {description && (
        <p
          className="text-base md:text-lg"
          style={{
            color: 'var(--color-text-secondary)',
            maxWidth: '55ch',
            lineHeight: 1.55,
          }}
        >
          {description}
        </p>
      )}
    </header>
  );
}
