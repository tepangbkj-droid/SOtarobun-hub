/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          purple: '#6D28D9',
          dark: '#1E1B4B',
          50: '#F5F3FF',
          100: '#EDE9FE',
          600: '#7C3AED',
          700: '#6D28D9',
          800: '#5B21B6',
          900: '#3B1370',
        },
        wheat: {
          50: '#FFFBEB',
          100: '#FEF3C7',
          500: '#D97706',
          600: '#B45309',
        },
        ink: '#1E1B2E',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 2px 8px -2px rgba(30, 27, 46, 0.06), 0 8px 24px -8px rgba(30, 27, 46, 0.10)',
        softHover: '0 4px 14px -2px rgba(30, 27, 46, 0.08), 0 16px 32px -12px rgba(30, 27, 46, 0.16)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
