import OpenGraphImage from './opengraph-image';

// Twitter Card image — riusa OGTemplate via componente OpenGraphImage condiviso.
// Twitter usa summary_large_image con stessa size 1200x630.
// Nota: i field `runtime`, `size`, `contentType`, `alt` devono essere
// dichiarati direttamente in questo file (Turbopack non li risolve via re-export).

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Federico Calicchia — Web Designer & Developer Freelance';

export default OpenGraphImage;
