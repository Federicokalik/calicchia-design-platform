import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Settings2 } from 'lucide-react';
import type { Node } from '@xyflow/react';
import { useI18n } from '@/hooks/use-i18n';

interface NodeInspectorProps {
  node: Node | null;
  onChange: (nodeId: string, data: any) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function NodeInspector({ node, onChange }: NodeInspectorProps) {
  const { t } = useI18n();
  if (!node) {
    return (
      <div className="flex h-full w-56 flex-col items-center justify-center border-l bg-card/50 p-4 text-center">
        <Settings2 className="mb-2 h-6 w-6 text-muted-foreground/20" />
        <p className="text-xs text-muted-foreground/50">{t('workflow.inspector.empty')}</p>
      </div>
    );
  }

  const data = node.data as Record<string, any>;
  const set = (key: string, value: any) => onChange(node.id, { [key]: value });

  return (
    <div className="flex h-full w-56 flex-col border-l bg-card/50">
      <div className="border-b px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">{t('workflow.inspector.config')}</p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
        {/* Name */}
        <Field label={t('common.name')}>
          <Input className="h-7 text-xs" value={data.label || ''} onChange={(e) => set('label', e.target.value)} />
        </Field>

        {/* LLM nodes */}
        {node.type?.startsWith('llm_') && (
          <>
            <Field label="Provider">
              <Select value={data.provider || 'auto'} onValueChange={(v) => set('provider', v)}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('workflow.field.providerAuto')}</SelectItem>
                  <SelectItem value="infomaniak">Infomaniak</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="perplexity">Perplexity</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Prompt">
              <Textarea className="text-xs min-h-[80px]" value={data.prompt || ''} onChange={(e) => set('prompt', e.target.value)} placeholder={t('workflow.field.promptPlaceholder')} />
            </Field>
            <Field label="Temperatura">
              <Input className="h-7 text-xs" type="number" min="0" max="2" step="0.1" value={data.temperature ?? 0.7} onChange={(e) => set('temperature', parseFloat(e.target.value))} />
            </Field>
          </>
        )}

        {/* Telegram */}
        {node.type === 'tool_send_telegram' && (
            <Field label={t('workflow.field.message')}>
            <Textarea className="text-xs min-h-[60px]" value={data.message || ''} onChange={(e) => set('message', e.target.value)} placeholder={t('workflow.field.promptPlaceholder')} />
          </Field>
        )}

        {/* WhatsApp */}
        {node.type === 'tool_send_whatsapp' && (
          <>
            <Field label={t('common.phone')}>
              <Input className="h-7 text-xs" value={data.phone || ''} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label={t('workflow.field.message')}>
              <Textarea className="text-xs min-h-[60px]" value={data.message || ''} onChange={(e) => set('message', e.target.value)} />
            </Field>
          </>
        )}

        {/* Email */}
        {node.type === 'tool_send_email' && (
          <>
            <Field label="A"><Input className="h-7 text-xs" value={data.to || ''} onChange={(e) => set('to', e.target.value)} /></Field>
            <Field label={t('workflow.field.subject')}><Input className="h-7 text-xs" value={data.subject || ''} onChange={(e) => set('subject', e.target.value)} /></Field>
            <Field label={t('workflow.field.body')}><Textarea className="text-xs min-h-[60px]" value={data.body || ''} onChange={(e) => set('body', e.target.value)} /></Field>
          </>
        )}

        {/* HTTP */}
        {node.type === 'tool_http_request' && (
          <>
            <Field label={t('workflow.field.method')}>
              <Select value={data.method || 'GET'} onValueChange={(v) => set('method', v)}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="URL"><Input className="h-7 text-xs" value={data.url || ''} onChange={(e) => set('url', e.target.value)} /></Field>
          </>
        )}

        {/* DB Query */}
        {node.type === 'tool_db_query' && (
          <Field label="Query SQL">
            <Textarea className="text-xs min-h-[80px] font-mono" value={data.query || ''} onChange={(e) => set('query', e.target.value)} />
          </Field>
        )}

        {/* Condition */}
        {node.type === 'logic_condition' && (
          <Field label={t('workflow.nodes.condition.label')}>
            <Input className="h-7 text-xs font-mono" value={data.condition || ''} onChange={(e) => set('condition', e.target.value)} placeholder="input.count > 0" />
          </Field>
        )}

        {/* Delay */}
        {node.type === 'logic_delay' && (
          <Field label={t('workflow.field.seconds')}>
            <Input className="h-7 text-xs" type="number" value={data.seconds || 5} onChange={(e) => set('seconds', parseInt(e.target.value))} />
          </Field>
        )}

        {/* Loop */}
        {node.type === 'logic_loop' && (
          <Field label={t('workflow.field.arrayField')}>
            <Input className="h-7 text-xs" value={data.array_field || 'rows'} onChange={(e) => set('array_field', e.target.value)} />
          </Field>
        )}

        {/* Cron */}
        {node.type === 'trigger_cron' && (
          <>
            <Field label={t('workflow.field.everyHours')}><Input className="h-7 text-xs" type="number" value={data.interval_hours || 24} onChange={(e) => set('interval_hours', parseInt(e.target.value))} /></Field>
            <Field label={t('workflow.field.time')}><Input className="h-7 text-xs" value={data.time || '09:00'} onChange={(e) => set('time', e.target.value)} placeholder="HH:MM" /></Field>
          </>
        )}

        {/* Event */}
        {node.type === 'trigger_event' && (
          <Field label={t('workflow.field.eventType')}>
            <Select value={data.event_type || 'nuovo_lead'} onValueChange={(v) => set('event_type', v)}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="nuovo_lead">{t('workflow.event.newLead')}</SelectItem>
                <SelectItem value="preventivo_firmato">{t('workflow.event.quoteSigned')}</SelectItem>
                <SelectItem value="booking_creato">{t('workflow.event.bookingCreated')}</SelectItem>
                <SelectItem value="lead_convertito">{t('workflow.event.leadConverted')}</SelectItem>
                <SelectItem value="task_completato">{t('workflow.event.taskCompleted')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}

        {/* Brain fact */}
        {node.type === 'output_brain_fact' && (
          <>
            <Field label={t('workflow.field.entityType')}><Input className="h-7 text-xs" value={data.entity_type || 'general'} onChange={(e) => set('entity_type', e.target.value)} /></Field>
            <Field label={t('workflow.field.fact')}><Textarea className="text-xs min-h-[60px]" value={data.fact || ''} onChange={(e) => set('fact', e.target.value)} placeholder={t('workflow.field.promptPlaceholder')} /></Field>
          </>
        )}

        {/* Log */}
        {node.type === 'output_log' && (
          <Field label={t('workflow.field.message')}>
            <Textarea className="text-xs min-h-[60px]" value={data.message || ''} onChange={(e) => set('message', e.target.value)} />
          </Field>
        )}
      </div>
    </div>
  );
}
