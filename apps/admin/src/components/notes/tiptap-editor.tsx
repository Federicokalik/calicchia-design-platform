import { useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { SlashCommands } from './slash-command';
import type { JSONContent } from '@tiptap/react';
import {
  Bold, Italic, Heading1, Heading2, Heading3, List, ListOrdered,
  Quote, Code, Link as LinkIcon, CheckSquare, ImageIcon, Undo, Redo, Minus,
  Keyboard, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface TiptapEditorProps {
  content: JSONContent | null;
  onChange: (json: JSONContent) => void;
  onForceSave?: () => void;
  className?: string;
  placeholder?: string;
}

const SHORTCUTS = [
  { keys: '# + spazio', desc: 'Titolo H1' },
  { keys: '## + spazio', desc: 'Titolo H2' },
  { keys: '### + spazio', desc: 'Titolo H3' },
  { keys: '> + spazio', desc: 'Citazione' },
  { keys: '- + spazio', desc: 'Lista puntata' },
  { keys: '1. + spazio', desc: 'Lista numerata' },
  { keys: '- [ ] + spazio', desc: 'Checklist' },
  { keys: '--- + invio', desc: 'Linea orizzontale' },
  { keys: '`testo`', desc: 'Codice inline' },
  { keys: '```+ invio', desc: 'Blocco codice' },
  { keys: '**testo**', desc: 'Grassetto' },
  { keys: '*testo*', desc: 'Corsivo' },
  { keys: 'Ctrl/⌘ + S', desc: 'Salva subito' },
  { keys: 'Ctrl/⌘ + Z', desc: 'Annulla' },
  { keys: 'Ctrl/⌘ + Shift + Z', desc: 'Ripeti' },
];

function ToolbarButton({ active, onClick, children, title }: {
  active?: boolean; onClick: () => void; children: React.ReactNode; title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'p-1.5 rounded-md transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export default function TiptapEditor({ content, onChange, onForceSave, className, placeholder }: TiptapEditorProps) {
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Cmd+S force save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onForceSave?.();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onForceSave]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: placeholder || 'Inizia a scrivere...',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-primary underline' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: false }),
      SlashCommands,
    ],
    content: content || undefined,
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON());
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[300px] px-4 py-3',
      },
    },
  });

  if (!editor) return null;

  const addLink = () => {
    const url = window.prompt('URL:');
    if (url) editor.chain().focus().setLink({ href: url }).run();
  };

  const addImage = () => {
    const url = window.prompt('URL immagine:');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  return (
    <div className={cn('rounded-xl border bg-card overflow-hidden', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b bg-muted/30">
        <ToolbarButton active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Grassetto">
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Corsivo">
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarButton active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="H1">
          <Heading1 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="H2">
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="H3">
          <Heading3 className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarButton active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Lista puntata">
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Lista numerata">
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()} title="Checklist">
          <CheckSquare className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarButton active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Citazione">
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Codice">
          <Code className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Linea orizzontale">
          <Minus className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarButton active={editor.isActive('link')} onClick={addLink} title="Link">
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={addImage} title="Immagine">
          <ImageIcon className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="flex-1" />

        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Annulla">
          <Undo className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Ripeti">
          <Redo className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarButton onClick={() => setShowShortcuts(!showShortcuts)} title="Scorciatoie" active={showShortcuts}>
          <Keyboard className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>

      {/* Shortcuts hint panel */}
      {showShortcuts && (
        <div className="px-4 py-3 border-b bg-muted/20 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-muted-foreground">Scorciatoie da tastiera</span>
            <button onClick={() => setShowShortcuts(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-center gap-2">
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono shrink-0">{s.keys}</kbd>
                <span className="text-muted-foreground truncate">{s.desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Editor content */}
      <EditorContent editor={editor} />
    </div>
  );
}
