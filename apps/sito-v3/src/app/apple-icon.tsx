import { ImageResponse } from 'next/og';

// Apple touch icon 180x180 — "FC" su sfondo nero, padding maggiorato per iOS.
export const runtime = 'nodejs';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#111',
          color: '#FAFAF7',
          fontSize: 88,
          fontWeight: 700,
          letterSpacing: '-0.05em',
          fontFamily: 'sans-serif',
        }}
      >
        FC
      </div>
    ),
    size,
  );
}
