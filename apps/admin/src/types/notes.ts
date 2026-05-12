export interface Note {
  id: string;
  title: string;
  content: Record<string, unknown> | null;
  raw_markdown: string | null;
  source: 'app' | 'telegram' | 'agent';
  tags: string[];
  linked_type: 'project' | 'customer' | null;
  linked_id: string | null;
  is_pinned: boolean;
  preview?: string;
  created_at: string;
  updated_at: string;
}

export interface Board {
  id: string;
  title: string;
  type: 'sketch' | 'mindmap';
  data: Record<string, unknown>;
  thumbnail: string | null;
  linked_type: 'project' | 'customer' | null;
  linked_id: string | null;
  created_at: string;
  updated_at: string;
}
