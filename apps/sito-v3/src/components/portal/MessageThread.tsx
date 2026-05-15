'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { postProjectMessageAction } from '@/lib/portal-actions';
import type { PortalMessage } from '@/lib/portal-api';

interface MessageThreadProps {
  projectId: string;
  messages: PortalMessage[];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function MessageThread({ projectId, messages }: MessageThreadProps) {
  // TODO P0-06 polish: optimistic send state, attachment support, better error recovery.
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col" style={{ borderTop: '1px solid var(--color-border)' }}>
        {messages.length === 0 ? (
          <p
            className="py-6 text-sm"
            style={{ color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border)' }}
          >
            Nessun messaggio su questo progetto.
          </p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-3 md:gap-8 py-6"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <div className="flex flex-col gap-2">
                <MonoLabel tone={message.sender_type === 'client' ? 'accent' : 'muted'}>
                  {message.sender_type === 'client' ? 'CLIENTE' : 'CALDES'}
                </MonoLabel>
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  {message.sender_name}
                </span>
                <MonoLabel>{formatDate(message.created_at)}</MonoLabel>
              </div>
              <p className="leading-relaxed" style={{ color: 'var(--color-text-primary)' }}>
                {message.content}
              </p>
            </article>
          ))
        )}
      </div>

      <form
        ref={formRef}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          setError(null);
          startTransition(async () => {
            try {
              await postProjectMessageAction(projectId, formData);
              formRef.current?.reset();
              router.refresh();
            } catch {
              setError('Messaggio non inviato. Riprova.');
            }
          });
        }}
      >
        <label className="flex flex-col gap-3">
          <MonoLabel as="span">NUOVO MESSAGGIO</MonoLabel>
          <textarea
            name="body"
            required
            rows={5}
            className="w-full resize-y px-4 py-4 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              color: 'var(--color-text-primary)',
            }}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--color-text-error)' }}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? 'Invio...' : 'Invia messaggio'}
        </Button>
      </form>
    </div>
  );
}
