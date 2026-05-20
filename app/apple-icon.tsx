import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#5E81AC',
          color: '#ECEFF4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 130,
          fontWeight: 800,
          fontFamily: 'system-ui, sans-serif',
          letterSpacing: -6,
        }}
      >
        K
      </div>
    ),
    { ...size },
  );
}
