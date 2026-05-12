import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CharacterCount from '@tiptap/extension-character-count';
import Highlight from '@tiptap/extension-highlight';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TextAlign from '@tiptap/extension-text-align';
import Typography from '@tiptap/extension-typography';
import Youtube from '@tiptap/extension-youtube';
import { Markdown } from '@tiptap/markdown';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo,
  Rows3,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline,
  Undo,
  Youtube as YoutubeIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RichEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: string;
}

interface EditorStats {
  characters: number;
  words: number;
}

function readMarkdown(editor: Editor) {
  return editor.getMarkdown();
}

function ToolbarButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-primary/12 text-primary',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="mx-1 h-6 w-px bg-border" />;
}

function promptUrl(label: string) {
  const url = window.prompt(label);
  return url?.trim() || null;
}

export function RichEditor({
  value = '',
  onChange,
  placeholder = 'Scrivi o incolla testo Markdown/plain...',
  className,
  minHeight = '300px',
}: RichEditorProps) {
  const lastValueRef = useRef(value);
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceValue, setSourceValue] = useState(value);
  const [stats, setStats] = useState<EditorStats>({ characters: 0, words: 0 });

  const extensions = useMemo(
    () => [
      // StarterKit v3 include `Link` di default → disabilitiamo qui per
      // permettere alla nostra config `Link` con autolink/linkOnPaste/HTMLAttributes
      // custom di sostituirla. Senza `link: false`, TipTap warn-a di duplicati e
      // il document NON si inizializza (ProseMirror resta senza nemmeno il
      // `<p>` empty default → editor invisibile sotto la toolbar).
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
      }),
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: false,
        },
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { class: 'text-primary underline underline-offset-2' },
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: 'rounded-md border' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({
        resizable: true,
        HTMLAttributes: { class: 'tiptap-table' },
      }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right', 'justify'],
      }),
      Highlight.configure({ multicolor: true }),
      Typography,
      Youtube.configure({
        controls: true,
        nocookie: true,
        HTMLAttributes: { class: 'tiptap-youtube' },
      }),
      CharacterCount,
    ],
    [placeholder]
  );

  const editor = useEditor({
    extensions,
    // Quando `value` è vuoto e contentType è 'markdown', il Markdown extension
    // lascia il document senza nodi → ProseMirror non crea il <p> empty
    // default e il placeholder rimane invisibile (i selettori `p.is-editor-empty`
    // non matchano nulla). Passare un paragrafo HTML vuoto come fallback fa sì
    // che TipTap inizializzi correttamente il document e il placeholder appaia.
    content: value && value.trim() ? value : '<p></p>',
    contentType: value && value.trim() ? 'markdown' : 'html',
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none px-4 py-3',
      },
    },
    onCreate: ({ editor }) => {
      setStats({
        characters: editor.storage.characterCount.characters(),
        words: editor.storage.characterCount.words(),
      });
    },
    onUpdate: ({ editor }) => {
      const markdown = readMarkdown(editor);
      lastValueRef.current = markdown;
      setStats({
        characters: editor.storage.characterCount.characters(),
        words: editor.storage.characterCount.words(),
      });
      onChange?.(markdown);
    },
  });

  useEffect(() => {
    if (!editor) return;

    const nextValue = value ?? '';
    if (nextValue === lastValueRef.current) return;

    if (sourceMode) {
      lastValueRef.current = nextValue;
      setSourceValue(nextValue);
      return;
    }

    const currentMarkdown = readMarkdown(editor);
    if (nextValue === currentMarkdown) {
      lastValueRef.current = nextValue;
      return;
    }

    editor.commands.setContent(nextValue, {
      contentType: 'markdown',
      emitUpdate: false,
    });
    lastValueRef.current = nextValue;
    setStats({
      characters: editor.storage.characterCount.characters(),
      words: editor.storage.characterCount.words(),
    });
  }, [editor, sourceMode, value]);

  const applySourceMarkdown = useCallback(
    (markdown: string) => {
      if (!editor) return;
      editor.commands.setContent(markdown, {
        contentType: 'markdown',
        emitUpdate: false,
      });
      lastValueRef.current = markdown;
      setStats({
        characters: editor.storage.characterCount.characters(),
        words: editor.storage.characterCount.words(),
      });
      onChange?.(markdown);
    },
    [editor, onChange]
  );

  const toggleSourceMode = () => {
    if (!editor) return;

    if (sourceMode) {
      applySourceMarkdown(sourceValue);
      setSourceMode(false);
      return;
    }

    setSourceValue(readMarkdown(editor));
    setSourceMode(true);
  };

  const addLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL link:', previousUrl || 'https://');

    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };

  const addImage = () => {
    if (!editor) return;
    const url = promptUrl('URL immagine:');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  const addYoutube = () => {
    if (!editor) return;
    const src = promptUrl('URL YouTube:');
    if (src) editor.chain().focus().setYoutubeVideo({ src, width: 640, height: 360 }).run();
  };

  if (!editor) return null;

  const disabled = sourceMode;

  return (
    <div className={cn('overflow-hidden rounded-md border bg-background', className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 px-2 py-1.5">
        <ToolbarButton disabled={disabled} onClick={() => editor.chain().focus().undo().run()} title="Annulla">
          <Undo className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton disabled={disabled} onClick={() => editor.chain().focus().redo().run()} title="Ripeti">
          <Redo className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton active={editor.isActive('bold')} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()} title="Grassetto">
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('italic')} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()} title="Corsivo">
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('underline')} disabled={disabled} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Sottolineato">
          <Underline className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('strike')} disabled={disabled} onClick={() => editor.chain().focus().toggleStrike().run()} title="Barrato">
          <Strikethrough className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('highlight')} disabled={disabled} onClick={() => editor.chain().focus().toggleHighlight({ color: '#fde68a' }).run()} title="Evidenzia">
          <Highlighter className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton active={editor.isActive('paragraph')} disabled={disabled} onClick={() => editor.chain().focus().setParagraph().run()} title="Paragrafo">
          <Pilcrow className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('heading', { level: 1 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Titolo 1">
          <Heading1 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('heading', { level: 2 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Titolo 2">
          <Heading2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('heading', { level: 3 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Titolo 3">
          <Heading3 className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton active={editor.isActive({ textAlign: 'left' })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign('left').run()} title="Allinea a sinistra">
          <AlignLeft className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive({ textAlign: 'center' })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign('center').run()} title="Centra">
          <AlignCenter className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive({ textAlign: 'right' })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign('right').run()} title="Allinea a destra">
          <AlignRight className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive({ textAlign: 'justify' })} disabled={disabled} onClick={() => editor.chain().focus().setTextAlign('justify').run()} title="Giustifica">
          <AlignJustify className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton active={editor.isActive('bulletList')} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Lista puntata">
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('orderedList')} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Lista numerata">
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('taskList')} disabled={disabled} onClick={() => editor.chain().focus().toggleTaskList().run()} title="Checklist">
          <ListChecks className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('blockquote')} disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Citazione">
          <Quote className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive('codeBlock')} disabled={disabled} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Blocco codice">
          <Code className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton disabled={disabled} onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Separatore">
          <Minus className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton active={editor.isActive('link')} disabled={disabled} onClick={addLink} title="Link">
          <LinkIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton disabled={disabled} onClick={addImage} title="Immagine">
          <ImageIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton disabled={disabled} onClick={addYoutube} title="YouTube">
          <YoutubeIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton disabled={disabled} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Inserisci tabella">
          <TableIcon className="h-4 w-4" />
        </ToolbarButton>

        {editor.isActive('table') && (
          <>
            <ToolbarButton disabled={disabled} onClick={() => editor.chain().focus().addRowAfter().run()} title="Aggiungi riga">
              <Rows3 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton disabled={disabled} onClick={() => editor.chain().focus().deleteTable().run()} title="Elimina tabella">
              <Trash2 className="h-4 w-4" />
            </ToolbarButton>
          </>
        )}

        <div className="min-w-2 flex-1" />

        <ToolbarButton active={sourceMode} onClick={toggleSourceMode} title={sourceMode ? 'Vista editor' : 'Sorgente Markdown'}>
          {sourceMode ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
        </ToolbarButton>
      </div>

      {sourceMode ? (
        <textarea
          value={sourceValue}
          onChange={(event) => {
            const markdown = event.target.value;
            setSourceValue(markdown);
            lastValueRef.current = markdown;
            onChange?.(markdown);
          }}
          className="w-full resize-y bg-background px-4 py-3 font-mono text-sm leading-6 outline-none"
          style={{ minHeight }}
          spellCheck={false}
        />
      ) : (
        <EditorContent editor={editor} style={{ minHeight }} />
      )}

      <div className="flex items-center justify-between border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>{sourceMode ? 'Markdown sorgente' : 'TipTap rich text'}</span>
        <span>{stats.words} parole · {stats.characters} caratteri</span>
      </div>
    </div>
  );
}

export default RichEditor;
