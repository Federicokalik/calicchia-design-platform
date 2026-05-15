import { ImageResponse } from 'next/og';

// Favicon 32x32 — tilde accent (richiama "~Design" del logo).
// La tilde di un glifo sans-serif si posiziona alta nel box;
// la spingo giù di pochi pixel con marginTop per centrarla visivamente.
export const runtime = 'nodejs';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0E0E0C',
          color: '#F57F44',
          fontSize: 34,
          fontWeight: 900,
          lineHeight: 1,
          fontFamily: 'sans-serif',
        }}
      >
        <span style={{ display: 'block', marginTop: 6 }}>~</span>
      </div>
    ),
    size,
  );
}
