import { ImageResponse } from 'next/og';

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
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
          fontSize: 360,
          fontWeight: 800,
          fontFamily: 'system-ui, sans-serif',
          letterSpacing: -20,
        }}
      >
        K
      </div>
    ),
    { ...size },
  );
}
