import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Section } from '@/components/ui/Section';
import type { ServiceExpandedScope as ScopeData } from '@/data/services-detail';

interface ServiceExpandedScopeProps {
  scope: ScopeData;
  /** Eyebrow ordinal numbering, e.g. "03". */
  index?: string;
}

/**
 * ServiceExpandedScope — narrative add-on per servizio (post-launch /
 * web-app / comunicazione coordinata). Pattern Swiss: rail sx mono +
 * heading display + body asymmetric, NO card, NO shadow.
 *
 * Renders only when the service has a non-empty `expandedScope` field
 * (added by Codex P0-03 to web-design / sviluppo-web / branding).
 */
export function ServiceExpandedScope({
  scope,
  index = '04',
}: ServiceExpandedScopeProps) {
  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-8">
        <div className="col-span-12 md:col-span-4">
          <Eyebrow as="p" mono className="mb-4">
            {`${index} — ${scope.eyebrow}`}
          </Eyebrow>
        </div>
        <div className="col-span-12 md:col-span-7 md:col-start-6">
          <Heading
            as="h2"
            size="display-md"
            className="mb-6"
            style={{ maxWidth: '22ch' }}
          >
            {scope.title}
          </Heading>
          <p
            className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
            style={{
              maxWidth: '85ch',
              color: 'var(--color-text-secondary)',
            }}
          >
            {scope.body}
          </p>
        </div>
      </div>
    </Section>
  );
}
