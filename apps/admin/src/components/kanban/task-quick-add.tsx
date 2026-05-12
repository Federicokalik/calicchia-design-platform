import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TaskQuickAddProps {
  onAdd: (title: string) => void;
  onCancel: () => void;
}

export function TaskQuickAdd({ onAdd, onCancel }: TaskQuickAddProps) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onAdd(title.trim());
      setTitle('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-2 shadow-sm">
      <Input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Titolo task..."
        className="mb-2 h-8 text-sm"
      />
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={!title.trim()}>
          Aggiungi
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Annulla
        </Button>
      </div>
    </form>
  );
}
