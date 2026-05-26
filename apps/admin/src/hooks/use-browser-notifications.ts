import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lightweight wrapper over the browser Notification API. The permission
 * grant requires a user gesture, so we expose `request()` for the caller
 * to bind to a button click — never auto-request on mount.
 *
 * The audio cue is generated with WebAudio (a short ~200ms 880Hz beep)
 * instead of shipping an MP3 asset. This keeps the bundle binary-free
 * and avoids the awkward "muted autoplay" failure mode on some browsers
 * because we only call `.start()` from inside a user-driven event chain
 * (SSE → invalidation → setState → render with new data → no, wait, SSE
 * is NOT a user gesture). Workaround: we lazily build the AudioContext
 * on the first `notify()` call; if the browser blocks the first beep we
 * silently swallow the error and rely on the notification toast instead.
 */
export type NotificationPermission_ = 'default' | 'granted' | 'denied' | 'unsupported';

interface NotifyArgs {
  title: string;
  body?: string;
  tag?: string;
  silent?: boolean;
}

export function useBrowserNotifications() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission_>(
    supported ? (Notification.permission as NotificationPermission_) : 'unsupported',
  );

  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureAudio = (): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtxRef.current) audioCtxRef.current = new Ctor();
    return audioCtxRef.current;
  };

  const beep = useCallback(() => {
    const ac = ensureAudio();
    if (!ac) return;
    try {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
      o.connect(g); g.connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.3);
    } catch { /* autoplay blocked or no permission — silent */ }
  }, []);

  const request = useCallback(async (): Promise<NotificationPermission_> => {
    if (!supported) return 'unsupported';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      setPermission(Notification.permission as NotificationPermission_);
      return Notification.permission as NotificationPermission_;
    }
    const next = await Notification.requestPermission();
    setPermission(next as NotificationPermission_);
    return next as NotificationPermission_;
  }, [supported]);

  const notify = useCallback(({ title, body, tag, silent }: NotifyArgs) => {
    if (!supported) return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag, silent: true });
    } catch { /* ignore */ }
    if (!silent) beep();
  }, [supported, beep]);

  // Keep our state field in sync if the user toggles permissions in browser settings.
  useEffect(() => {
    if (!supported) return;
    const interval = setInterval(() => {
      const cur = Notification.permission as NotificationPermission_;
      setPermission((prev) => (prev === cur ? prev : cur));
    }, 5000);
    return () => clearInterval(interval);
  }, [supported]);

  return { supported, permission, request, notify, beep };
}
