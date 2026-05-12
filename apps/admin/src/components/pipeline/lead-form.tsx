import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { LeadSource, LeadStatus } from '@/types/lead';
import { LEAD_SOURCE_CONFIG } from '@/types/lead';
import { useI18n } from '@/hooks/use-i18n';

interface LeadFormProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: {
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    source: LeadSource;
    status: LeadStatus;
    estimated_value: number | null;
  }) => void;
  defaultStatus?: LeadStatus;
}

export function LeadForm({ open, onClose, onCreate, defaultStatus = 'new' }: LeadFormProps) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    source: 'manual' as LeadSource,
    estimated_value: '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;

    onCreate({
      name: form.name.trim(),
      email: form.email || null,
      phone: form.phone || null,
      company: form.company || null,
      source: form.source,
      status: defaultStatus,
      estimated_value: form.estimated_value ? parseFloat(form.estimated_value) : null,
    });

    setForm({ name: '', email: '', phone: '', company: '', source: 'manual', estimated_value: '' });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('lead.new')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('common.name')} *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('lead.fullName')}
              autoFocus
            />
          </div>

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

          <div className="space-y-1.5">
            <Label>{t('common.company')}</Label>
            <Input
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
            />
          </div>

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
              <Label>{t('lead.estimatedValue')}</Label>
              <Input
                type="number"
                value={form.estimated_value}
                onChange={(e) => setForm({ ...form, estimated_value: e.target.value })}
                placeholder="2500"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!form.name.trim()}>
              {t('lead.new')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
