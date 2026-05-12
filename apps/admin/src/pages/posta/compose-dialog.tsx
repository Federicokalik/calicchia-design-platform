import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';

export interface ComposePrefill {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  in_reply_to?: string;
  references?: string[];
  /** If set, the draft is deleted from /api/mail/drafts after a successful send. */
  draft_id?: string;
}

interface ComposeDialogProps {
  open: boolean;
  onClose: () => void;
  accountId: string;
  prefill?: ComposePrefill;
}

export function ComposeDialog({ open, onClose, accountId, prefill }: ComposeDialogProps) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (open) {
      setTo(prefill?.to || '');
      setCc(prefill?.cc || '');
      setSubject(prefill?.subject || '');
      setBody(prefill?.body || '');
    }
  }, [open, prefill]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      await apiFetch('/api/mail/send', {
        method: 'POST',
        body: JSON.stringify({
          account_id: accountId,
          to: to.split(',').map((s) => s.trim()).filter(Boolean),
          cc: cc ? cc.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          subject,
          text: body,
          in_reply_to: prefill?.in_reply_to,
          references: prefill?.references,
        }),
      });
      // If we're sending an AI-drafted email, mark it as sent and cleanup
      if (prefill?.draft_id) {
        try {
          await apiFetch(`/api/mail/drafts/${prefill.draft_id}`, { method: 'DELETE' });
        } catch {
          // draft cleanup failure is non-blocking
        }
      }
    },
    onSuccess: () => {
      toast.success('Email inviata');
      onClose();
    },
    onError: (err) => toast.error(`Invio fallito: ${(err as Error).message}`),
  });

  const canSend = !!to.trim() && !!subject.trim() && !!body.trim();

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nuovo messaggio</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="compose-to">A</Label>
            <Input
              id="compose-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="destinatario@esempio.it (più indirizzi separati da virgola)"
            />
          </div>
          <div>
            <Label htmlFor="compose-cc">CC</Label>
            <Input
              id="compose-cc"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="(opzionale)"
            />
          </div>
          <div>
            <Label htmlFor="compose-subject">Oggetto</Label>
            <Input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="compose-body">Messaggio</Label>
            <textarea
              id="compose-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Scrivi il messaggio…"
              className="w-full min-h-[200px] rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button disabled={!canSend || sendMutation.isPending} onClick={() => sendMutation.mutate()}>
            {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
            Invia
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
