import { useState, type DragEvent } from 'react';
import { cn } from '@/lib/utils';
import {
  ChevronDown, Zap, Clock, Globe, Mail, Sparkles, MessageSquare,
  FileText, Send, Database, GitBranch, Timer, Repeat,
  ArrowRightFromLine, Brain, Tag,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

const categories: Array<{ id: string; labelKey: string; color: string; items: Array<{ nodeType: string; labelKey: string; icon: LucideIcon; descriptionKey: string }> }> = [
  {
    id: 'trigger', labelKey: 'workflow.nodes.trigger', color: 'text-emerald-500',
    items: [
      { nodeType: 'trigger_manual', labelKey: 'workflow.nodes.manual.label', icon: Zap, descriptionKey: 'workflow.nodes.manual.description' },
      { nodeType: 'trigger_cron', labelKey: 'workflow.nodes.timer.label', icon: Clock, descriptionKey: 'workflow.nodes.timer.description' },
      { nodeType: 'trigger_event', labelKey: 'workflow.nodes.event.label', icon: Zap, descriptionKey: 'workflow.nodes.event.description' },
      { nodeType: 'trigger_webhook', labelKey: 'Webhook', icon: Globe, descriptionKey: 'workflow.nodes.webhook.description' },
      { nodeType: 'trigger_telegram', labelKey: 'Telegram', icon: MessageSquare, descriptionKey: 'workflow.nodes.telegram.description' },
    ],
  },
  {
    id: 'llm', labelKey: 'AI / LLM', color: 'text-violet-500',
    items: [
      { nodeType: 'llm_chat', labelKey: 'workflow.nodes.llmChat.label', icon: Sparkles, descriptionKey: 'workflow.nodes.llmChat.description' },
      { nodeType: 'llm_summarize', labelKey: 'workflow.nodes.summarize.label', icon: FileText, descriptionKey: 'workflow.nodes.summarize.description' },
      { nodeType: 'llm_classify', labelKey: 'workflow.nodes.classify.label', icon: Tag, descriptionKey: 'workflow.nodes.classify.description' },
    ],
  },
  {
    id: 'tool', labelKey: 'workflow.nodes.actions', color: 'text-blue-500',
    items: [
      { nodeType: 'tool_send_telegram', labelKey: 'Telegram', icon: Send, descriptionKey: 'workflow.nodes.sendTelegram.description' },
      { nodeType: 'tool_send_email', labelKey: 'Email', icon: Mail, descriptionKey: 'workflow.nodes.sendEmail.description' },
      { nodeType: 'tool_send_whatsapp', labelKey: 'WhatsApp', icon: MessageSquare, descriptionKey: 'workflow.nodes.sendWhatsapp.description' },
      { nodeType: 'tool_http_request', labelKey: 'HTTP', icon: Globe, descriptionKey: 'workflow.nodes.http.description' },
      { nodeType: 'tool_db_query', labelKey: 'workflow.nodes.db.label', icon: Database, descriptionKey: 'workflow.nodes.db.description' },
    ],
  },
  {
    id: 'logic', labelKey: 'workflow.nodes.logic', color: 'text-amber-500',
    items: [
      { nodeType: 'logic_condition', labelKey: 'workflow.nodes.condition.label', icon: GitBranch, descriptionKey: 'workflow.nodes.condition.description' },
      { nodeType: 'logic_delay', labelKey: 'workflow.nodes.delay.label', icon: Timer, descriptionKey: 'workflow.nodes.delay.description' },
      { nodeType: 'logic_loop', labelKey: 'workflow.nodes.loop.label', icon: Repeat, descriptionKey: 'workflow.nodes.loop.description' },
    ],
  },
  {
    id: 'output', labelKey: 'workflow.nodes.output', color: 'text-zinc-400',
    items: [
      { nodeType: 'output_log', labelKey: 'Log', icon: ArrowRightFromLine, descriptionKey: 'workflow.nodes.log.description' },
      { nodeType: 'output_brain_fact', labelKey: 'workflow.nodes.memory.label', icon: Brain, descriptionKey: 'workflow.nodes.memory.description' },
    ],
  },
];

function onDragStart(event: DragEvent, nodeType: string) {
  event.dataTransfer.setData('application/reactflow', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

export function NodePalette() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <div className="flex h-full w-48 flex-col border-r bg-card/50">
      <div className="border-b px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">{t('workflow.palette.nodes')}</p>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        {categories.map((cat) => (
          <div key={cat.id} className="mb-1">
            <button
              onClick={() => setCollapsed((p) => ({ ...p, [cat.id]: !p[cat.id] }))}
              className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider hover:bg-muted/50"
            >
              <span className={cat.color}>{t(cat.labelKey)}</span>
              <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', collapsed[cat.id] && '-rotate-90')} />
            </button>
            {!collapsed[cat.id] && (
              <div className="mt-0.5 space-y-0.5">
                {cat.items.map((item) => (
                  <div
                    key={item.nodeType}
                    draggable
                    onDragStart={(e) => onDragStart(e, item.nodeType)}
                    className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50 active:cursor-grabbing"
                  >
                    <item.icon className={cn('h-3.5 w-3.5 shrink-0', cat.color)} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium leading-tight">{t(item.labelKey)}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{t(item.descriptionKey)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
