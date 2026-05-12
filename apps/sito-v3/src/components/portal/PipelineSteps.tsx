import { MonoLabel } from '@/components/ui/MonoLabel';

interface PipelineStepsProps {
  steps: string[];
  currentStep?: string | null;
}

export function PipelineSteps({ steps, currentStep }: PipelineStepsProps) {
  if (!steps.length) return null;

  const activeIndex = currentStep ? steps.findIndex((step) => step === currentStep) : -1;

  return (
    <ol className="flex flex-col" style={{ borderTop: '1px solid var(--color-border)' }}>
      {steps.map((step, index) => {
        const active = index === activeIndex || (activeIndex === -1 && index === 0);
        const done = activeIndex > index;

        return (
          <li
            key={`${step}-${index}`}
            className="grid grid-cols-[56px_1fr] gap-5 py-5"
            style={{ borderBottom: '1px solid var(--color-border)', opacity: done ? 0.6 : 1 }}
          >
            <MonoLabel tone={active ? 'accent' : 'muted'}>
              {String(index + 1).padStart(2, '0')}
            </MonoLabel>
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="block size-2"
                style={{
                  background: active ? 'var(--color-link-hover)' : 'var(--color-border-strong)',
                }}
              />
              <span style={{ color: 'var(--color-text-primary)' }}>{step}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
