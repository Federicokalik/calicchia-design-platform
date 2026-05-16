import { lazy, Suspense } from 'react';
import {
  ExternalLink, Receipt, CreditCard, Link2, Repeat, FileCode2,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTopbar } from '@/hooks/use-topbar';

const SchedulesTab = lazy(() => import('@/components/fatturazione/schedules-tab'));
const LinksTab = lazy(() => import('@/components/fatturazione/links-tab'));
const TrackerTab = lazy(() => import('@/components/fatturazione/tracker-tab'));
const SubscriptionsTab = lazy(() => import('@/components/fatturazione/subscriptions-tab'));
const SdiTab = lazy(() => import('@/components/fatturazione/sdi-tab'));

function TabFallback() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

export default function FatturazionePage() {
  useTopbar({
    title: 'Fatturazione',
    subtitle: 'Pagamenti, link e tracker',
  });

  return (
    <div className="space-y-4">
      <Tabs defaultValue="pagamenti">
        <TabsList>
          <TabsTrigger value="desksite" className="gap-1.5">
            <ExternalLink className="h-3.5 w-3.5" />
            Desksite
          </TabsTrigger>
          <TabsTrigger value="pagamenti" className="gap-1.5">
            <CreditCard className="h-3.5 w-3.5" />
            Pagamenti
          </TabsTrigger>
          <TabsTrigger value="links" className="gap-1.5">
            <Link2 className="h-3.5 w-3.5" />
            Link
          </TabsTrigger>
          <TabsTrigger value="subscriptions" className="gap-1.5">
            <Repeat className="h-3.5 w-3.5" />
            Abbonamenti
          </TabsTrigger>
          <TabsTrigger value="tracker" className="gap-1.5">
            <Receipt className="h-3.5 w-3.5" />
            Tracker
          </TabsTrigger>
          <TabsTrigger value="sdi" className="gap-1.5">
            <FileCode2 className="h-3.5 w-3.5" />
            XML SDI
          </TabsTrigger>
        </TabsList>

        {/* Desksite iframe */}
        <TabsContent value="desksite" className="mt-4">
          <div className="rounded-lg border bg-card overflow-hidden" style={{ height: 'calc(100vh - 260px)' }}>
            <iframe
              src="https://app.desksite.it"
              className="w-full h-full border-0"
              title="Desksite Fatturazione"
              allow="clipboard-write"
            />
          </div>
        </TabsContent>

        {/* Payment schedules */}
        <TabsContent value="pagamenti" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <SchedulesTab />
          </Suspense>
        </TabsContent>

        {/* Payment links */}
        <TabsContent value="links" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <LinksTab />
          </Suspense>
        </TabsContent>

        {/* Subscriptions */}
        <TabsContent value="subscriptions" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <SubscriptionsTab />
          </Suspense>
        </TabsContent>

        {/* Manual tracker */}
        <TabsContent value="tracker" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <TrackerTab />
          </Suspense>
        </TabsContent>

        {/* SDI / FatturaPA XML */}
        <TabsContent value="sdi" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <SdiTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
