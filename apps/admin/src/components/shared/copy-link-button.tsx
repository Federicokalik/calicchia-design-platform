import { useState } from 'react';
import { Link as LinkIcon, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface CopyLinkButtonProps {
  /** Override the URL to copy. Defaults to current window.location.href. */
  url?: string;
}

export function CopyLinkButton({ url }: CopyLinkButtonProps = {}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url ?? window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked; do nothing visible
    }
  };

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleCopy}
          aria-label="Copia link alla pagina"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <LinkIcon className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {copied ? 'Copiato' : 'Copia link alla pagina'}
      </TooltipContent>
    </Tooltip>
  );
}
