import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'KAST Earn Tracker',
    short_name: 'KAST Earn',
    description:
      'Daily TVL snapshot across USDKY (Solana) and Gauntlet Alpha Vault (Base).',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ECEFF4',
    theme_color: '#5E81AC',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-180x180.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
