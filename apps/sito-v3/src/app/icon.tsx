import { ImageResponse } from 'next/og';

// Favicon 32x32 generato dinamicamente — "FC" su sfondo nero, monospaziato.
// Niente PNG statico in /public: Next.js lo serve come /icon.
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
          background: '#111',
          color: '#FAFAF7',
          fontSize: 18,
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
