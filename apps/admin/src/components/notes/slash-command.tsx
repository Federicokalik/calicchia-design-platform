import { Extension } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import {
  forwardRef, useEffect, useImperativeHandle, useState,
} from 'react';
import {
  Heading1, Heading2, Heading3, List, ListOrdered, CheckSquare,
  Quote, Code, Minus, ImageIcon, AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CommandItem {
  title: string;
  description: string;
  icon: React.ElementType;
  command: (editor: any) => void;
}

const COMMANDS: CommandItem[] = [
  {
    title: 'Titolo 1', description: 'Titolo grande', icon: Heading1,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    title: 'Titolo 2', description: 'Titolo medio', icon: Heading2,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    title: 'Titolo 3', description: 'Titolo piccolo', icon: Heading3,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    title: 'Lista puntata', description: 'Lista con punti', icon: List,
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    title: 'Lista numerata', description: 'Lista con numeri', icon: ListOrdered,
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    title: 'Checklist', description: 'Lista con checkbox', icon: CheckSquare,
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    title: 'Citazione', description: 'Blocco citazione', icon: Quote,
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    title: 'Codice', description: 'Blocco di codice', icon: Code,
    command: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    title: 'Separatore', description: 'Linea orizzontale', icon: Minus,
    command: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    title: 'Immagine', description: 'Inserisci immagine da URL', icon: ImageIcon,
    command: (editor) => {
      const url = window.prompt('URL immagine:');
      if (url) editor.chain().focus().setImage({ src: url }).run();
    },
  },
  {
    title: 'Callout', description: 'Nota di attenzione', icon: AlertCircle,
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
];

interface CommandListProps {
  items: CommandItem[];
  command: (item: CommandItem) => void;
}

interface CommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const CommandList = forwardRef<CommandListRef, CommandListProps>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => setSelectedIndex(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        if (items[selectedIndex]) command(items[selectedIndex]);
        return true;
      }
      return false;
    },
  }));

  if (!items.length) return null;

  return (
    <div className="z-50 w-56 rounded-xl border bg-popover p-1 shadow-lg max-h-[300px] overflow-y-auto">
      {items.map((item, i) => (
        <button
          key={item.title}
          onClick={() => command(item)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            i === selectedIndex ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
          )}
        >
          <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-xs">{item.title}</p>
            <p className="text-[10px] text-muted-foreground">{item.description}</p>
          </div>
        </button>
      ))}
    </div>
  );
});

CommandList.displayName = 'CommandList';

export const SlashCommands = Extension.create({
  name: 'slashCommands',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({ editor, range, props }: any) => {
          editor.chain().focus().deleteRange(range).run();
          props.command(editor);
        },
        items: ({ query }: { query: string }) => {
          return COMMANDS.filter((item) =>
            item.title.toLowerCase().includes(query.toLowerCase()) ||
            item.description.toLowerCase().includes(query.toLowerCase())
          ).slice(0, 10);
        },
        render: () => {
          let component: ReactRenderer | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(CommandList, {
                props,
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy('body', {
                getReferenceClientRect: props.clientRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
              });
            },
            onUpdate: (props: any) => {
              component?.updateProps(props);
              if (popup?.[0] && props.clientRect) {
                popup[0].setProps({ getReferenceClientRect: props.clientRect });
              }
            },
            onKeyDown: (props: any) => {
              if (props.event.key === 'Escape') {
                popup?.[0]?.hide();
                return true;
              }
              return (component?.ref as any)?.onKeyDown?.(props) ?? false;
            },
            onExit: () => {
              popup?.[0]?.destroy();
              component?.destroy();
            },
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
