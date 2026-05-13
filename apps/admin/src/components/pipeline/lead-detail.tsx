import { useState } from 'react';
import {
  ArrowRightCircle, Trash2, FileSignature,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { Lead, LeadStatus, LeadSource } from '@/types/lead';
import { LEAD_STATUS_CONFIG, LEAD_SOURCE_CONFIG } from '@/types/lead';
import { useI18n } from '@/hooks/use-i18n';

interface LeadDetailProps {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
  onSave: (lead: Partial<Lead> & { id: string }) => void;
  onDelete: (id: string) => void;
  onConvert: (lead: Lead) => void;
  onCreateQuote?: (lead: Lead) => void;
}

export function LeadDetail({ lead, open, onClose, onSave, onDelete, onConvert, onCreateQuote }: LeadDetailProps) {
  const { t, formatDate } = useI18n();

  const [form, setForm] = useState({
    name: lead?.name ?? '',
    email: lead?.email || '',
    phone: lead?.phone || '',
    company: lead?.company || '',
    source: lead?.source ?? 'manual',
    status: lead?.status ?? 'new',
    estimated_value: lead?.estimated_value?.toString() || '',
    notes: lead?.notes || '',
    lost_reason: lead?.lost_reason || '',
  });

  if (!lead) return null;

  const handleSave = () => {
    onSave({
      id: lead.id,
      name: form.name,
      email: form.email || null,
      phone: form.phone || null,
      company: form.company || null,
      source: form.source,
      status: form.status,
      estimated_value: form.estimated_value ? parseFloat(form.estimated_value) : null,
      notes: form.notes || null,
      lost_reason: form.lost_reason || null,
    });
  };

  const statusConfig = LEAD_STATUS_CONFIG[lead.status];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <SheetTitle className="flex-1">{lead.name}</SheetTitle>
            <Badge className={cn('text-xs', statusConfig.bgColor, statusConfig.color)} variant="outline">
              {t(statusConfig.labelKey)}
            </Badge>
          </div>
        </SheetHeader>

        <div className="space-y-4 mt-6">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>{t('common.name')}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          {/* Email + Phone */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('common.phone')}</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
          </div>

          {/* Company */}
          <div className="space-y-1.5">
            <Label>{t('common.company')}</Label>
            <Input
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
            />
          </div>

          {/* Source + Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('common.source')}</Label>
              <Select
                value={form.source}
                onValueChange={(v) => setForm({ ...form, source: v as LeadSource })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LEAD_SOURCE_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{t(cfg.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('common.status')}</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as LeadStatus })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LEAD_STATUS_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{t(cfg.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Estimated value */}
          <div className="space-y-1.5">
            <Label>{t('lead.estimatedValue')}</Label>
            <Input
              type="number"
              value={form.estimated_value}
              onChange={(e) => setForm({ ...form, estimated_value: e.target.value })}
              placeholder="2500"
            />
          </div>

          {/* Lost reason (only if lost) */}
          {form.status === 'lost' && (
            <div className="space-y-1.5">
              <Label>{t('lead.lostReason')}</Label>
              <Input
                value={form.lost_reason}
                onChange={(e) => setForm({ ...form, lost_reason: e.target.value })}
                placeholder={t('lead.lostReasonPlaceholder')}
              />
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label>{t('common.notes')}</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              placeholder={t('lead.notesPlaceholder')}
            />
          </div>

          {/* Meta */}
          <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
            <p>{t('common.created')}: {formatDate(lead.created_at, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
            <p>{t('common.updated')}: {formatDate(lead.updated_at, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave} className="flex-1">
              {t('common.save')}
            </Button>
            {lead.status !== 'won' && lead.status !== 'lost' && onCreateQuote && (
              <Button variant="outline" onClick={() => onCreateQuote(lead)}>
                <FileSignature className="h-4 w-4 mr-1.5" />
                {t('lead.createQuote')}
              </Button>
            )}
            {lead.status !== 'won' && lead.status !== 'lost' && (
              <Button variant="ghost" onClick={() => onConvert(lead)}>
                <ArrowRightCircle className="h-4 w-4 mr-1.5" />
                {t('lead.convert')}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => onDelete(lead.id)}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
