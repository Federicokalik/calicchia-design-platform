'use client';

import { ArrowUpRight, MapPin } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { SITE } from '@/data/site';
import {
  getConsent,
  hasConsent,
  installCookieConsentGlobals,
  setConsent,
} from '@/lib/cookie-consent';

const MAP_SCRIPT_ID = 'google-maps-footer-script';

const SWISS_LIGHT_STYLES: Array<Record<string, unknown>> = [
  { featureType: 'all', elementType: 'labels.text.fill', stylers: [{ color: '#2d2b26' }] },
  { featureType: 'all', elementType: 'labels.text.stroke', stylers: [{ color: '#f6f1e8' }, { weight: 2 }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#c8bfb0' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#eee6d9' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#d8cfc1' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6f665a' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cfd8d8' }] },
];

function directionsUrl() {
  return `https://www.google.com/maps/dir/?api=1&destination=${SITE.geo.lat},${SITE.geo.lng}`;
}

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();

  const existing = document.getElementById(MAP_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Maps failed to load')), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    window.__resolveGoogleMapsFooter = () => resolve();
    const script = document.createElement('script');
    script.id = MAP_SCRIPT_ID;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=__resolveGoogleMapsFooter&loading=async`;
    script.async = true;
    script.defer = true;
    script.addEventListener('error', () => reject(new Error('Google Maps failed to load')), { once: true });
    document.head.appendChild(script);
  });
}

export function FooterMap() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [canLoad, setCanLoad] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? '';

  useEffect(() => {
    installCookieConsentGlobals();
    setCanLoad(hasConsent('marketing'));

    const onConsentChanged = () => {
      setCanLoad(hasConsent('marketing'));
    };

    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => window.removeEventListener('cookie-consent-changed', onConsentChanged);
  }, []);

  useEffect(() => {
    const el = mapRef.current;
    if (!canLoad || !apiKey || !el) return;
    let cancelled = false;
    setMapReady(false);

    loadGoogleMaps(apiKey)
      .then(async () => {
        if (cancelled || !window.google?.maps || !mapRef.current) return;
        // Usiamo il classico google.maps.Marker invece di AdvancedMarkerElement
        // perché quest'ultimo richiede un mapId Cloud-configurato che disabilita
        // gli styles JS-based (SWISS_LIGHT_STYLES). Senza mapId la console emette
        // il warning "indicatori avanzati non disponibili". Marker è deprecato
        // (21-feb-2024) ma supportato senza data di rimozione e compatibile con
        // gli styles custom.
        const [{ Map }, { Marker }] = await Promise.all([
          window.google.maps.importLibrary('maps'),
          window.google.maps.importLibrary('marker'),
        ]);
        if (cancelled || !mapRef.current) return;

        const map = new Map(mapRef.current, {
          center: { lat: SITE.geo.lat, lng: SITE.geo.lng },
          zoom: 15,
          backgroundColor: '#eee6d9',
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: 'cooperative',
          keyboardShortcuts: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          zoomControl: false,
          styles: SWISS_LIGHT_STYLES,
        });

        new Marker({
          position: { lat: SITE.geo.lat, lng: SITE.geo.lng },
          map,
          title: SITE.legalName,
          icon: {
            url:
              'data:image/svg+xml;utf8,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42"><circle cx="21" cy="21" r="18" fill="#f57f44"/><circle cx="21" cy="21" r="8" fill="#11110f"/></svg>',
              ),
            scaledSize: new window.google.maps.Size(42, 42),
            anchor: new window.google.maps.Point(21, 21),
          },
        });
        setMapReady(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, canLoad]);

  const acceptMarketing = () => {
    const current = getConsent()?.preferences;
    setConsent({
      analytics: current?.analytics ?? false,
      marketing: true,
    });
  };

  if (!canLoad) {
    return (
      <div
        className="flex min-h-[260px] flex-col justify-between border p-6"
        style={{ borderColor: 'rgba(250,250,247,0.14)', background: '#11110f' }}
      >
        <div>
          <MapPin size={24} weight="regular" aria-hidden />
          <p
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.24em]"
            style={{ color: 'rgba(250,250,247,0.48)' }}
          >
            Google Maps bloccato
          </p>
          <p className="mt-4 max-w-[32ch] text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.68)' }}>
            Per mostrare la mappa dello studio serve il consenso ai contenuti di
            terze parti.
          </p>
        </div>

        <button
          type="button"
          onClick={acceptMarketing}
          className="mt-8 inline-flex min-h-[44px] items-center justify-center gap-3 border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
          style={{ borderColor: 'rgba(250,250,247,0.24)', color: '#FAFAF7' }}
        >
          Accetta terze parti e carica mappa
          <ArrowUpRight size={16} aria-hidden />
        </button>
      </div>
    );
  }

  if (!apiKey || loadFailed) {
    return (
      <div
        className="relative flex min-h-[320px] flex-col justify-between overflow-hidden border p-6 lg:min-h-[472px]"
        style={{
          borderColor: 'rgba(250,250,247,0.28)',
          background:
            'linear-gradient(35deg, transparent 44%, rgba(17,17,15,0.10) 45%, rgba(17,17,15,0.10) 46%, transparent 47%), linear-gradient(145deg, transparent 50%, rgba(245,127,68,0.38) 51%, rgba(245,127,68,0.38) 52%, transparent 53%), #eee6d9',
          backgroundSize: '92px 92px, 138px 138px, auto',
          color: '#11110f',
        }}
      >
        <div>
          <MapPin size={24} weight="regular" aria-hidden />
          <p
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.24em]"
            style={{ color: 'rgba(17,17,15,0.52)' }}
          >
            Google Maps API non disponibile
          </p>
          <p className="mt-4 max-w-[32ch] text-sm leading-relaxed" style={{ color: 'rgba(17,17,15,0.72)' }}>
            {SITE.contact.address}
          </p>
        </div>
        <a
          href={directionsUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 inline-flex min-h-[44px] items-center justify-center gap-3 border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
          style={{ borderColor: 'rgba(17,17,15,0.22)', color: '#11110f' }}
        >
          Apri indicazioni
          <span aria-hidden>→</span>
        </a>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-[320px] overflow-hidden border lg:min-h-[472px]"
      style={{
        borderColor: 'rgba(250,250,247,0.28)',
        background:
          'linear-gradient(35deg, transparent 44%, rgba(17,17,15,0.10) 45%, rgba(17,17,15,0.10) 46%, transparent 47%), linear-gradient(145deg, transparent 50%, rgba(245,127,68,0.38) 51%, rgba(245,127,68,0.38) 52%, transparent 53%), #eee6d9',
        backgroundSize: '92px 92px, 138px 138px, auto',
      }}
    >
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: mapReady ? 0 : 1,
          background:
            'radial-gradient(circle at 68% 38%, rgba(245,127,68,0.34), transparent 20%), linear-gradient(35deg, transparent 44%, rgba(17,17,15,0.10) 45%, rgba(17,17,15,0.10) 46%, transparent 47%), linear-gradient(145deg, transparent 50%, rgba(17,17,15,0.08) 51%, rgba(17,17,15,0.08) 52%, transparent 53%), #eee6d9',
          backgroundSize: 'auto, 92px 92px, 138px 138px, auto',
        }}
      />
      <div
        ref={mapRef}
        className="absolute inset-0 transition-opacity duration-500"
        aria-label="Mappa dello studio Calicchia Design"
        style={{ opacity: mapReady ? 1 : 0 }}
      />
      <div
        className="absolute left-4 right-4 top-4 flex flex-col gap-1 border p-4 md:flex-row md:items-center md:justify-between"
        style={{
          background: 'rgba(17,17,15,0.86)',
          borderColor: 'rgba(250,250,247,0.14)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <div>
          <p className="text-sm font-medium">Calicchia Design</p>
          <p className="mt-1 text-xs" style={{ color: 'rgba(250,250,247,0.62)' }}>
            {SITE.contact.address}
          </p>
        </div>
        <div className="mt-3 flex flex-col items-start gap-1 md:mt-0 md:items-end">
          <a
            href={directionsUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em]"
            style={{ color: 'var(--color-accent)' }}
          >
            Indicazioni
            <span aria-hidden>→</span>
          </a>
          <p
            className="font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: 'rgba(250,250,247,0.72)' }}
          >
            Ricevo solo su appuntamento
          </p>
        </div>
      </div>
    </div>
  );
}
