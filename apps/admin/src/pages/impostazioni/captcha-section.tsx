/**
 * Sezione "Captcha (Cap)" in Impostazioni → Sicurezza & accesso.
 *
 * Embed via iframe della dashboard del container Cap self-hosted
 * (https://trycap.dev). Niente UI nativa — la dashboard built-in copre già
 * site key, secret, analytics. L'auth dell'iframe è gestita dal browser
 * dell'utente (cookie session su `cap.calicchia.design`, password admin
 * impostata via env `CAP_ADMIN_PASSWORD`).
 *
 * Trade-off: ergonomia ridotta vs UI integrata, ma zero codice da mantenere
 * e parity 1:1 con la release Cap upstream. Se in futuro serve UI nativa
 * (es. metriche per form), promuovere a admin pages che chiamano
 * `https://cap.calicchia.design/api/*` via proxy api con `Authorization: Bot $CAP_API_KEY`.
 */

import { ArrowUpRight, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CAP_DASHBOARD_URL =
  import.meta.env.VITE_CAP_DASHBOARD_URL || 'https://cap.calicchia.design/dashboard';

export function CaptchaSection() {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Captcha (Cap)</h2>
          </div>
          <p className="text-xs text-muted-foreground max-w-2xl">
            Dashboard del container Cap self-hosted. Gestisci da qui le{' '}
            <em>site key</em> per i form pubblici (login portale, contatti, prenotazioni,
            newsletter, GDPR). Niente terze parti, niente tracking — il PoW gira sul tuo VPS.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <a href={CAP_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
            Apri in nuova scheda
            <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
          </a>
        </Button>
      </header>

      <div className="rounded border bg-muted/30 overflow-hidden">
        <iframe
          src={CAP_DASHBOARD_URL}
          title="Cap captcha dashboard"
          className="w-full min-h-[640px] border-0"
          // sandbox: lascia abilitati script (necessari per la dashboard) e same-origin
          // (cookie auth). Il subdomain è nostro, no rischio cross-origin XSS verso admin.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}
