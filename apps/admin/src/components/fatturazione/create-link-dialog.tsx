import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CreditCard,
  Landmark,
  ExternalLink,
  Copy,
  Loader2,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ProviderInfo {
  enabled: boolean;
  configured: boolean;
  label: string;
}

interface ProvidersResponse {
  providers: {
    stripe: ProviderInfo;
    paypal: ProviderInfo;
    revolut: ProviderInfo;
    bank_transfer: ProviderInfo;
  };
}

interface CreateLinkResponse {
  link: {
    id: string;
    checkout_url?: string;
  };
  bank_details?: {
    iban: string;
    bic: string;
    intestatario: string;
    causale: string;
  };
}

interface CreateLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  scheduleId?: string;
  defaultAmount?: number;
  defaultDescription?: string;
  defaultCurrency?: string;
}

type ProviderKey = "stripe" | "paypal" | "revolut" | "bank_transfer";

const providerConfig: Record<
  ProviderKey,
  { icon: typeof CreditCard; color: string; borderColor: string }
> = {
  stripe: {
    icon: CreditCard,
    color: "text-purple-600",
    borderColor: "border-purple-500 bg-purple-50 dark:bg-purple-950/30",
  },
  paypal: {
    icon: CreditCard,
    color: "text-blue-600",
    borderColor: "border-blue-500 bg-blue-50 dark:bg-blue-950/30",
  },
  revolut: {
    icon: CreditCard,
    color: "text-indigo-600",
    borderColor: "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30",
  },
  bank_transfer: {
    icon: Landmark,
    color: "text-zinc-600",
    borderColor: "border-zinc-500 bg-zinc-50 dark:bg-zinc-950/30",
  },
};

export default function CreateLinkDialog({
  open,
  onOpenChange,
  onCreated,
  scheduleId,
  defaultAmount,
  defaultDescription,
  defaultCurrency,
}: CreateLinkDialogProps) {
  const [provider, setProvider] = useState<ProviderKey | null>(null);
  const [amount, setAmount] = useState(defaultAmount?.toString() ?? "");
  const [description, setDescription] = useState(defaultDescription ?? "");
  const [currency, setCurrency] = useState(defaultCurrency ?? "EUR");
  const [result, setResult] = useState<CreateLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: providersData, isLoading: loadingProviders } =
    useQuery<ProvidersResponse>({
      queryKey: ["payment-providers"],
      queryFn: () => apiFetch("/api/payments/providers"),
      enabled: open,
    });

  const createMutation = useMutation({
    mutationFn: (body: {
      provider: ProviderKey;
      amount: number;
      currency: string;
      description: string;
      payment_schedule_id?: string;
    }) =>
      apiFetch("/api/payments/links", {
        method: "POST",
        body: JSON.stringify(body),
      }) as Promise<CreateLinkResponse>,
    onSuccess: (data) => {
      setResult(data);
      toast.success("Link di pagamento creato");
      onCreated();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Errore nella creazione del link");
    },
  });

  function handleCreate() {
    if (!provider || !amount) return;
    createMutation.mutate({
      provider,
      amount: parseFloat(amount),
      currency,
      description,
      payment_schedule_id: scheduleId,
    });
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copiato negli appunti");
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setResult(null);
    setProvider(null);
    setAmount(defaultAmount?.toString() ?? "");
    setDescription(defaultDescription ?? "");
    setCurrency(defaultCurrency ?? "EUR");
    setCopied(false);
    onOpenChange(false);
  }

  const providers = providersData?.providers;

  // ---------- Success state ----------
  if (result) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40">
                <Check className="h-4 w-4 text-green-600" />
              </div>
              Link creato con successo
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {result.link.checkout_url && (
              <div className="space-y-2">
                <Label>URL di pagamento</Label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={result.link.checkout_url}
                    className="text-xs"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => handleCopy(result.link.checkout_url!)}
                  >
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    asChild
                  >
                    <a
                      href={result.link.checkout_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </div>
            )}

            {result.bank_details && (
              <div className="space-y-3 rounded-lg border p-4">
                <h4 className="text-sm font-semibold">
                  Coordinate bancarie
                </h4>
                <div className="grid gap-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">IBAN</span>
                    <button
                      onClick={() => handleCopy(result.bank_details!.iban)}
                      className="flex items-center gap-1 font-mono hover:text-primary"
                    >
                      {result.bank_details.iban}
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">BIC</span>
                    <span className="font-mono">
                      {result.bank_details.bic}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Intestatario</span>
                    <span>{result.bank_details.intestatario}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Causale</span>
                    <span className="text-right max-w-[200px]">
                      {result.bank_details.causale}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={handleClose}>Chiudi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ---------- Creation form ----------
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Crea link di pagamento</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Provider selection */}
          <div className="space-y-2">
            <Label>Metodo di pagamento</Label>
            {loadingProviders ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {(
                  Object.entries(providers ?? {}) as [
                    ProviderKey,
                    ProviderInfo,
                  ][]
                ).map(([key, info]) => {
                  const cfg = providerConfig[key];
                  const Icon = cfg.icon;
                  const selected = provider === key;
                  const disabled = !info.configured;

                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={disabled}
                      onClick={() => setProvider(key)}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-sm font-medium transition-all",
                        selected
                          ? cfg.borderColor
                          : "border-transparent bg-muted/40 hover:bg-muted",
                        disabled && "cursor-not-allowed opacity-40"
                      )}
                    >
                      <Icon className={cn("h-6 w-6", cfg.color)} />
                      <span>{info.label}</span>
                      {!info.configured && (
                        <Badge variant="outline" className="text-[10px]">
                          Non configurato
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <Label htmlFor="link-amount">Importo &euro;</Label>
            <Input
              id="link-amount"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="link-description">Descrizione</Label>
            <Input
              id="link-description"
              placeholder="Descrizione del pagamento"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Currency */}
          <div className="space-y-2">
            <Label>Valuta</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EUR">EUR</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="GBP">GBP</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!provider || !amount || createMutation.isPending}
          >
            {createMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Crea link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
