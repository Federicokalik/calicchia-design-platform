import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTopbar } from '@/hooks/use-topbar';
import { LoadingState } from '@/components/shared/loading-state';
import {
  Users,
  Eye,
  Mail,
  TrendingUp,
  Globe,
  Smartphone,
  Monitor,
  Tablet,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api';

interface AnalyticsData {
  period: string;
  overview: {
    pageViews: number;
    uniqueVisitors: number;
    contacts: number;
    avgPagesPerVisitor: string;
  };
  blog: {
    totalPosts: number;
    publishedPosts: number;
    totalViews: number;
  };
  newsletter: {
    total: number;
    confirmed: number;
    pending: number;
    unsubscribed: number;
  };
  topPages: { path: string; views: number }[];
  topReferrers: { domain: string; count: number }[];
  devices: Record<string, number>;
}

function StatCard({
  title,
  value,
  icon: Icon,
  description,
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  description?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceIcon({ type }: { type: string }) {
  switch (type.toLowerCase()) {
    case 'mobile':
      return <Smartphone className="h-4 w-4" />;
    case 'tablet':
      return <Tablet className="h-4 w-4" />;
    default:
      return <Monitor className="h-4 w-4" />;
  }
}

export default function AnalyticsPage() {
  const [period, setPeriod] = useState('7d');

  const { data, isLoading, error } = useQuery<AnalyticsData>({
    queryKey: ['analytics', period],
    queryFn: async () => {
      return apiFetch(`/api/analytics?period=${period}`);
    },
  });

  const topbarActions = useMemo(() => (
    <Select value={period} onValueChange={setPeriod}>
      <SelectTrigger className="w-36 h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="24h">Ultime 24 ore</SelectItem>
        <SelectItem value="7d">Ultimi 7 giorni</SelectItem>
        <SelectItem value="30d">Ultimi 30 giorni</SelectItem>
        <SelectItem value="90d">Ultimi 90 giorni</SelectItem>
      </SelectContent>
    </Select>
  ), [period]);

  useTopbar({
    title: 'Analytics',
    subtitle: data ? `${data.overview.pageViews.toLocaleString()} visualizzazioni · ${data.overview.uniqueVisitors.toLocaleString()} visitatori` : '',
    actions: topbarActions,
  });

  if (isLoading) {
    return <LoadingState />;
  }

  if (error || !data) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Errore caricamento analytics</p>
      </div>
    );
  }

  const totalDevices = Object.values(data.devices).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">

      {/* Overview Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Visualizzazioni"
          value={data.overview.pageViews.toLocaleString()}
          icon={Eye}
        />
        <StatCard
          title="Visitatori Unici"
          value={data.overview.uniqueVisitors.toLocaleString()}
          icon={Users}
        />
        <StatCard
          title="Contatti"
          value={data.overview.contacts}
          icon={Mail}
        />
        <StatCard
          title="Pagine/Visita"
          value={data.overview.avgPagesPerVisitor}
          icon={TrendingUp}
        />
      </div>

      {/* Blog & Newsletter Stats */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Blog</CardTitle>
            <CardDescription>Statistiche articoli</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span>Articoli pubblicati</span>
              <span className="font-medium">{data.blog.publishedPosts}</span>
            </div>
            <div className="flex justify-between">
              <span>Visualizzazioni totali</span>
              <span className="font-medium">{data.blog.totalViews.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span>Media views/articolo</span>
              <span className="font-medium">
                {data.blog.publishedPosts > 0
                  ? Math.round(data.blog.totalViews / data.blog.publishedPosts)
                  : 0}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Newsletter</CardTitle>
            <CardDescription>Iscritti alla newsletter</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span>Confermati</span>
              <span className="font-medium text-green-600">{data.newsletter.confirmed}</span>
            </div>
            <div className="flex justify-between">
              <span>In attesa</span>
              <span className="font-medium text-yellow-600">{data.newsletter.pending}</span>
            </div>
            <div className="flex justify-between">
              <span>Disiscritti</span>
              <span className="font-medium text-muted-foreground">{data.newsletter.unsubscribed}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top Pages & Referrers */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pagine più visitate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.topPages.length > 0 ? (
                data.topPages.map((page, i) => (
                  <div key={page.path} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-4">{i + 1}.</span>
                      <span className="truncate max-w-[200px]">{page.path}</span>
                    </div>
                    <span className="font-medium">{page.views}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-center py-4">
                  Nessun dato disponibile
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Top Referrer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.topReferrers.length > 0 ? (
                data.topReferrers.map((ref, i) => (
                  <div key={ref.domain} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-4">{i + 1}.</span>
                      <span className="truncate max-w-[200px]">{ref.domain}</span>
                    </div>
                    <span className="font-medium">{ref.count}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-center py-4">
                  Nessun referrer registrato
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Devices */}
      <Card>
        <CardHeader>
          <CardTitle>Dispositivi</CardTitle>
          <CardDescription>Distribuzione per tipo di dispositivo</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            {Object.entries(data.devices).map(([type, count]) => {
              const percentage = totalDevices > 0 ? ((count / totalDevices) * 100).toFixed(1) : 0;
              return (
                <div key={type} className="flex items-center gap-3">
                  <DeviceIcon type={type} />
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <span className="capitalize">{type}</span>
                      <span className="text-muted-foreground">{percentage}%</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export { AnalyticsPage };
