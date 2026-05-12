import { cn } from '@/lib/utils';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';

export interface ExecutionStep {
  node_id: string;
  node_type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration_ms?: number;
  error?: string;
}

interface ExecutionPanelProps {
  steps: ExecutionStep[];
  executionStatus: string;
}

const statusConfig = {
  pending: {
    icon: Clock,
    color: 'text-gray-400',
    bg: 'bg-gray-50',
    label: 'In attesa',
  },
  running: {
    icon: Loader2,
    color: 'text-blue-500',
    bg: 'bg-blue-50',
    label: 'In esecuzione',
  },
  completed: {
    icon: CheckCircle2,
    color: 'text-green-500',
    bg: 'bg-green-50',
    label: 'Completato',
  },
  failed: {
    icon: XCircle,
    color: 'text-red-500',
    bg: 'bg-red-50',
    label: 'Errore',
  },
} as const;

const nodeTypeLabels: Record<string, string> = {
  trigger_manual: 'Trigger manuale',
  trigger_schedule: 'Trigger schedulato',
  trigger_webhook: 'Webhook',
  trigger_email: 'Email ricevuta',
  llm_chat: 'Chat LLM',
  llm_summarize: 'Riassumi',
  llm_classify: 'Classifica',
  tool_send_telegram: 'Invio Telegram',
  tool_send_email: 'Invio Email',
  tool_http_request: 'HTTP Request',
  tool_db_query: 'Query DB',
  tool_create_event: 'Crea Evento',
  logic_condition: 'Condizione',
  logic_delay: 'Ritardo',
  logic_loop: 'Loop',
  output_response: 'Risposta',
  output_notification: 'Notifica',
  output_log: 'Log',
};

function formatDuration(ms?: number) {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ExecutionPanel({ steps, executionStatus }: ExecutionPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const { t, locale } = useI18n();

  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const failedCount = steps.filter((s) => s.status === 'failed').length;

  return (
    <div className="border-t bg-white">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-2 hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            {t('workflow.executionPanel.title')}
          </h4>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
              executionStatus === 'running' && 'bg-blue-50 text-blue-700',
              executionStatus === 'completed' && 'bg-green-50 text-green-700',
              executionStatus === 'failed' && 'bg-red-50 text-red-700',
              executionStatus === 'idle' && 'bg-gray-100 text-gray-500'
            )}
          >
            {t(`workflow.executionStatus.${executionStatus}`)}
          </span>
          {steps.length > 0 && (
            <span className="text-[11px] text-gray-400">
              {t('workflow.executionPanel.progress', { completed: completedCount, total: steps.length })}
              {failedCount > 0 && ` - ${t('workflow.executionPanel.errors', { count: failedCount })}`}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronUp className="h-4 w-4 text-gray-400" />
        )}
      </button>

      {/* Steps */}
      {expanded && (
        <div className="max-h-48 overflow-y-auto border-t">
          {steps.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              {t('workflow.executionPanel.empty')}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50/50 text-left text-[11px] uppercase tracking-wider text-gray-400">
                  <th className="px-4 py-1.5 font-medium">{t('common.status')}</th>
                  <th className="px-4 py-1.5 font-medium">{t('workflow.executionPanel.node')}</th>
                  <th className="px-4 py-1.5 font-medium">{t('workflow.executionPanel.type')}</th>
                  <th className="px-4 py-1.5 font-medium text-right">{t('workflow.executionPanel.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, i) => {
                  const config = statusConfig[step.status];
                  const StatusIcon = config.icon;

                  return (
                    <tr
                      key={`${step.node_id}-${i}`}
                      className={cn(
                        'border-b last:border-0',
                        step.status === 'failed' && 'bg-red-50/30'
                      )}
                    >
                      <td className="px-4 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <StatusIcon
                            className={cn(
                              'h-4 w-4',
                              config.color,
                              step.status === 'running' && 'animate-spin'
                            )}
                          />
                          <span
                            className={cn('text-xs font-medium', config.color)}
                          >
                            {t(`workflow.status.${step.status}`)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-1.5">
                        <span className="font-mono text-xs text-gray-500">
                          {step.node_id}
                        </span>
                      </td>
                      <td className="px-4 py-1.5">
                        <span className="text-xs text-gray-700">
                          {locale === 'en' ? step.node_type.replace(/_/g, ' ') : (nodeTypeLabels[step.node_type] ?? step.node_type)}
                        </span>
                      </td>
                      <td className="px-4 py-1.5 text-right">
                        <span className="font-mono text-xs text-gray-500">
                          {formatDuration(step.duration_ms)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Error details */}
          {steps
            .filter((s) => s.error)
            .map((step, i) => (
              <div
                key={`err-${step.node_id}-${i}`}
                className="border-t border-red-100 bg-red-50/50 px-4 py-2"
              >
                <p className="text-xs font-medium text-red-600">
                  {t('workflow.executionPanel.errorIn', { node: nodeTypeLabels[step.node_type] ?? step.node_type, id: step.node_id })}
                </p>
                <p className="mt-0.5 font-mono text-xs text-red-500">
                  {step.error}
                </p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
