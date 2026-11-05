import { useState, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, Loader2, Paperclip, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';

/** Allegato già salvato sul server (es. di una bozza): si rimanda come riferimento {url, filename}. */
export interface ComposeRemoteAttachment {
  url: string;
  filename: string;
  size: number;
  content_type?: string;
}

export interface ComposePrefill {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  in_reply_to?: string;
  references?: string[];
  /** If set, the draft is deleted from /api/mail/drafts after a successful send. */
  draft_id?: string;
  /** Allegati della bozza (URL firmati di /api/files/mail/...). */
  attachments?: ComposeRemoteAttachment[];
}

interface ComposeDialogProps {
  open: boolean;
  onClose: () => void;
  accountId: string;
  prefill?: ComposePrefill;
}

// Stessi limiti e tipi del server (apps/api/src/lib/mail/attachments.ts): qui solo
// per avvisare subito, la validazione vera resta lato API.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.zip,.docx,.xlsx,.txt,.csv';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type AttachmentItem =
  | { kind: 'local'; key: string; file: File }
  | { kind: 'remote'; key: string; remote: ComposeRemoteAttachment };

function itemName(a: AttachmentItem): string {
  return a.kind === 'local' ? a.file.name : a.remote.filename;
}
function itemSize(a: AttachmentItem): number {
  return a.kind === 'local' ? a.file.size : a.remote.size;
}

export function ComposeDialog({ open, onClose, accountId, prefill }: ComposeDialogProps) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTo(prefill?.to || '');
      setCc(prefill?.cc || '');
      setSubject(prefill?.subject || '');
      setBody(prefill?.body || '');
      setAttachments(
        (prefill?.attachments ?? []).map((remote, i) => ({ kind: 'remote', key: `remote-${i}-${remote.url}`, remote })),
      );
    }
  }, [open, prefill]);

  const totalSize = attachments.reduce((n, a) => n + itemSize(a), 0);

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (next.length >= MAX_FILES) {
        toast.error(`Al massimo ${MAX_FILES} allegati`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name}: supera 10 MB`);
        continue;
      }
      next.push({ kind: 'local', key: `local-${Date.now()}-${file.name}-${file.size}`, file });
    }
    setAttachments(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const sendMutation = useMutation({
    mutationFn: async () => {
      const toList = to.split(',').map((s) => s.trim()).filter(Boolean);
      const ccList = cc ? cc.split(',').map((s) => s.trim()).filter(Boolean) : [];

      let request: RequestInit;
      if (attachments.length) {
        // multipart: file locali nel campo attachments, allegati della bozza come riferimenti JSON.
        const form = new FormData();
        form.append('account_id', accountId);
        form.append('to', toList.join(', '));
        if (ccList.length) form.append('cc', ccList.join(', '));
        form.append('subject', subject);
        form.append('text', body);
        if (prefill?.in_reply_to) form.append('in_reply_to', prefill.in_reply_to);
        for (const ref of prefill?.references ?? []) form.append('references', ref);
        for (const a of attachments) {
          if (a.kind === 'local') form.append('attachments', a.file, a.file.name);
          else form.append('attachments', JSON.stringify({ url: a.remote.url, filename: a.remote.filename }));
        }
        request = { method: 'POST', body: form };
      } else {
        request = {
          method: 'POST',
          body: JSON.stringify({
            account_id: accountId,
            to: toList,
            cc: ccList.length ? ccList : undefined,
            subject,
            text: body,
            in_reply_to: prefill?.in_reply_to,
            references: prefill?.references,
          }),
        };
      }

      const res = await apiFetch('/api/mail/send', request);
      // If we're sending an AI-drafted email, cleanup the draft (and its stored attachments)
      if (prefill?.draft_id) {
        try {
          await apiFetch(`/api/mail/drafts/${prefill.draft_id}`, { method: 'DELETE' });
        } catch {
          // draft cleanup failure is non-blocking
        }
      }
      return res as { sent_copy?: { status: string; error?: string } };
    },
    onSuccess: (res) => {
      toast.success('Email inviata');
      if (res?.sent_copy?.status === 'failed') {
        toast.warning(`Email inviata, ma la copia in Inviati non è stata salvata: ${res.sent_copy.error ?? 'errore IMAP'}`);
      }
      onClose();
    },
    onError: (err) => toast.error(`Invio fallito: ${(err as Error).message}`),
  });

  const canSend = !!to.trim() && !!subject.trim() && !!body.trim() && totalSize <= MAX_TOTAL_BYTES;

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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Allegati</Label>
              <span className={totalSize > MAX_TOTAL_BYTES ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {formatSize(totalSize)} / 20 MB
              </span>
            </div>
            {attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((a) => (
                  <li key={a.key} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                    <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1">{itemName(a)}</span>
                    <span className="text-xs text-muted-foreground">{formatSize(itemSize(a))}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={`Rimuovi ${itemName(a)}`}
                      onClick={() => setAttachments((list) => list.filter((x) => x.key !== a.key))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={attachments.length >= MAX_FILES}>
              <Paperclip className="h-4 w-4 mr-2" /> Allega file
            </Button>
            <p className="text-xs text-muted-foreground">PDF, PNG, JPG, WEBP, ZIP, DOCX, XLSX, TXT, CSV · max 10 MB per file</p>
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
