import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#171a21', 900: '#232733', 700: '#3d4354', 500: '#6b7186', 300: '#a9aebd', 100: '#e6e8ee' },
        paper: { DEFAULT: '#f7f6f2', card: '#ffffff' },
        indigoy: { 700: '#2f3e78', 600: '#3a4d96', 100: '#e7eaf6' },
        saff: { 600: '#c56a1a', 100: '#fbeedd' },
        leaf: { 700: '#1f6f43', 100: '#e2f2e8' },
        brick: { 700: '#a5372c', 100: '#f9e5e2' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
