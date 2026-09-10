export const designTokens = {
  primary: '#4f5f90',
  primaryContainer: '#dce2ff',
  surface: '#fbf8ff',
  surfaceContainer: '#efedf4',
  canvas: '#f5f2f9',
  onSurface: '#1a1b20',
  onSurfaceVariant: '#45464f',
  outline: '#767780',
  outlineVariant: '#c6c6d0',
  radius: '16px',
  radiusSmall: '12px',
} as const;

export type DesignTokenName = keyof typeof designTokens;
