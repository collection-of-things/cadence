import 'react';

// Custom properties (`--acc`, `--page-tint`, …) are valid inline styles.
declare module 'react' {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
