import type {
  ConsentRecord,
  CookiePreferences,
} from '@/lib/cookie-consent';

export {};

type GoogleMapsLatLng = { lat: number; lng: number };

type GoogleMapsMapOptions = {
  backgroundColor?: string;
  center: GoogleMapsLatLng;
  clickableIcons?: boolean;
  zoom: number;
  disableDefaultUI?: boolean;
  fullscreenControl?: boolean;
  gestureHandling?: string;
  keyboardShortcuts?: boolean;
  mapId?: string;
  mapTypeControl?: boolean;
  streetViewControl?: boolean;
  styles?: Array<Record<string, unknown>>;
  zoomControl?: boolean;
};

type GoogleMapsLibrary = {
  Map: new (element: HTMLElement, options: GoogleMapsMapOptions) => unknown;
};

type GoogleMapsSize = new (width: number, height: number) => unknown;
type GoogleMapsPoint = new (x: number, y: number) => unknown;

type GoogleMarkerIcon = {
  url: string;
  scaledSize?: unknown;
  anchor?: unknown;
};

type GoogleMarkerLibrary = {
  AdvancedMarkerElement: new (options: {
    position: GoogleMapsLatLng;
    map: unknown;
    title?: string;
    content?: HTMLElement;
  }) => unknown;
  Marker: new (options: {
    position: GoogleMapsLatLng;
    map: unknown;
    title?: string;
    icon?: GoogleMarkerIcon;
  }) => unknown;
};

type GoogleMapsImportLibrary = ((name: 'maps') => Promise<GoogleMapsLibrary>) &
  ((name: 'marker') => Promise<GoogleMarkerLibrary>);

type MouseflowApi = {
  start?: () => void;
  stop?: () => void;
  stopSession?: () => void;
  isRecording?: () => boolean;
};

declare global {
  interface Window {
    [key: `ga-disable-${string}`]: boolean | undefined;
    __cookieConsent?: {
      read: () => ConsentRecord | null;
      has: (category: keyof CookiePreferences) => boolean;
      save: (preferences: Partial<CookiePreferences>) => ConsentRecord;
    };
    __googleAnalyticsConfigured?: boolean;
    __lastGoogleAnalyticsPageView?: string;
    __openCookiePreferences?: () => void;
    __resolveGoogleMapsFooter?: () => void;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    google?: {
      maps: {
        importLibrary: GoogleMapsImportLibrary;
        Size: GoogleMapsSize;
        Point: GoogleMapsPoint;
      };
    };
    mouseflow?: MouseflowApi;
    _mfq?: unknown[];
  }

  interface WindowEventMap {
    'cookie-consent-changed': CustomEvent<ConsentRecord>;
  }
}
