/**
 * Design tokens. AMOLED black, Apple-like.
 *  - Ground is true #000 so OLED pixels switch off; elevation is a small step up in fill, never a shadow stack.
 *  - Text uses Apple's dark label grays. Colour is reserved for meaning: tier light, ownership, win/loss.
 *  - Archivo (variable width + weight) is the display voice, set expanded; Geist carries all UI text.
 * Legacy token names (surface, raised, line, ink, muted, faint, accent...) are kept so every screen
 * picks up the new look; `rounded-sm` etc. are re-mapped to the softer scale.
 */
module.exports = {
  content: [__dirname + '/renderer/index.html', __dirname + '/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#000000',
        surface: '#0b0b0d',
        raised: '#151517',
        hover: '#1d1d20',
        line: 'rgba(255,255,255,0.08)',
        line2: 'rgba(255,255,255,0.14)',
        ink: '#f5f5f7',
        muted: '#a1a1a6',
        faint: '#76767b',
        accent: '#ffffff',
        atk: '#ff6b61',
        def: '#5ad8c6',
        win: '#32d74b',
        loss: '#ff453a',
        warn: '#ffd60a',
      },
      fontFamily: {
        display: ['"Archivo Variable"', '"Segoe UI Variable Display"', 'system-ui', 'sans-serif'],
        sans: ['"Geist Variable"', '"Segoe UI Variable Text"', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['11px', '14px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        md: ['16px', '22px'],
        lg: ['20px', '26px'],
        xl: ['28px', '32px'],
        '2xl': ['40px', '42px'],
        '3xl': ['64px', '60px'],
        // Fluid display sizes: full size on a large window, scaled down (never below the floor) on a small one.
        page: ['clamp(27px, 1.25vw + 13px, 34px)', '1.08'],
        hero: ['clamp(42px, 2.6vw + 14px, 56px)', '1.02'],
        'hero-sm': ['clamp(30px, 1.2vw + 16px, 38px)', '1.05'],
        stat: ['clamp(26px, 1.1vw + 13px, 34px)', '1'],
      },
      borderRadius: {
        none: '0',
        sm: '10px',
        DEFAULT: '12px',
        md: '14px',
        lg: '18px',
        xl: '22px',
        '2xl': '28px',
        '3xl': '36px',
      },
      letterSpacing: { label: '0', wide: '0' },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
        drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      transitionDuration: { 120: '120ms', 180: '180ms', 240: '240ms', 320: '320ms' },
    },
  },
  plugins: [],
};
