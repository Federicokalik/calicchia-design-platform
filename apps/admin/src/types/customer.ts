export type CustomerStatus = 'active' | 'inactive' | 'suspended';

export interface Customer {
  id: string;
  contact_name: string;
  company_name: string | null;
  email: string;
  phone: string | null;
  billing_address: Record<string, unknown>;
  notes: string | null;
  tags: string[];
  status: CustomerStatus;
  total_revenue: number;
  lifetime_value: number;
  lead_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerNote {
  id: string;
  customer_id: string;
  content: string;
  type: 'note' | 'email' | 'call' | 'meeting';
  created_at: string;
}

export const CUSTOMER_STATUS_CONFIG: Record<CustomerStatus, { label: string; color: string; bgColor: string }> = {
  active: { label: 'Attivo', color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  inactive: { label: 'Inattivo', color: 'text-zinc-500', bgColor: 'bg-zinc-100 dark:bg-zinc-800' },
  suspended: { label: 'Sospeso', color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-900/30' },
};

export const NOTE_TYPE_CONFIG: Record<string, { label: string; icon: string }> = {
  note: { label: 'Nota', icon: 'FileText' },
  email: { label: 'Email', icon: 'Mail' },
  call: { label: 'Chiamata', icon: 'Phone' },
  meeting: { label: 'Meeting', icon: 'Video' },
};
