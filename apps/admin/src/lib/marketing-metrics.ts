// Channel → structured metric fields, shared by the report form and the
// campaign KPI target/actual editor. Keeps metrics comparable across campaigns.

export interface MetricField {
  key: string;
  label: string;
  kind: 'number' | 'currency' | 'percent';
}

const PAID: MetricField[] = [
  { key: 'spend', label: 'Spesa', kind: 'currency' },
  { key: 'impressions', label: 'Impression', kind: 'number' },
  { key: 'clicks', label: 'Click', kind: 'number' },
  { key: 'leads', label: 'Lead', kind: 'number' },
  { key: 'conversions', label: 'Conversioni', kind: 'number' },
  { key: 'revenue', label: 'Ricavo attribuito', kind: 'currency' },
];

const SOCIAL: MetricField[] = [
  { key: 'reach', label: 'Reach', kind: 'number' },
  { key: 'impressions', label: 'Impression', kind: 'number' },
  { key: 'engagement', label: 'Engagement', kind: 'number' },
  { key: 'clicks', label: 'Click', kind: 'number' },
  { key: 'followers_gained', label: 'Nuovi follower', kind: 'number' },
  { key: 'spend', label: 'Spesa', kind: 'currency' },
];

const EMAIL: MetricField[] = [
  { key: 'sent', label: 'Inviate', kind: 'number' },
  { key: 'opens', label: 'Aperture', kind: 'number' },
  { key: 'clicks', label: 'Click', kind: 'number' },
  { key: 'unsubscribes', label: 'Disiscrizioni', kind: 'number' },
  { key: 'conversions', label: 'Conversioni', kind: 'number' },
];

const PRINT: MetricField[] = [
  { key: 'reach', label: 'Copie / Reach', kind: 'number' },
  { key: 'leads', label: 'Lead', kind: 'number' },
  { key: 'spend', label: 'Spesa', kind: 'currency' },
];

export const CHANNEL_METRICS: Record<string, MetricField[]> = {
  instagram: SOCIAL,
  facebook: SOCIAL,
  linkedin: SOCIAL,
  tiktok: SOCIAL,
  youtube: SOCIAL,
  google: PAID,
  email: EMAIL,
  print: PRINT,
  multi: PAID,
  other: PAID,
};

export function metricsForChannel(channel: string): MetricField[] {
  return CHANNEL_METRICS[channel] || PAID;
}

export interface DerivedKpis {
  ctr: number | null;
  cpl: number | null;
  cpc: number | null;
  conversionRate: number | null;
  roas: number | null;
}

/**
 * Compute derived KPIs (CTR, CPL, CPC, conversion rate, ROAS) from a raw
 * metrics object. Returns null for any KPI whose inputs are missing/zero.
 */
export function deriveKpis(metrics: Record<string, unknown> | null | undefined): DerivedKpis {
  const num = (k: string) => Number((metrics?.[k] as number | string | undefined) || 0);
  const spend = num('spend');
  const clicks = num('clicks');
  const impressions = num('impressions');
  const leads = num('leads');
  const conversions = num('conversions');
  const revenue = num('revenue');

  return {
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpl: leads > 0 ? spend / leads : null,
    cpc: clicks > 0 ? spend / clicks : null,
    conversionRate: clicks > 0
      ? (conversions / clicks) * 100
      : leads > 0 ? (conversions / leads) * 100 : null,
    roas: spend > 0 && revenue > 0 ? revenue / spend : null,
  };
}

export const DERIVED_KPI_LABELS: Record<keyof DerivedKpis, string> = {
  ctr: 'CTR',
  cpl: 'CPL',
  cpc: 'CPC',
  conversionRate: 'Conversione',
  roas: 'ROAS',
};
