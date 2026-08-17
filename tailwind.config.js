/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 色值统一定义在 src/index.css 的 :root 变量层(石墨中性基底,亮度与旧海军蓝板逐档等亮)
        'nai-bg': 'rgb(var(--nai-bg) / <alpha-value>)',
        'nai-panel': 'rgb(var(--nai-panel) / <alpha-value>)',
        'nai-input': 'rgb(var(--nai-input) / <alpha-value>)',
        'nai-accent': 'rgb(var(--nai-accent) / <alpha-value>)',
        'nai-accent-hover': 'rgb(var(--nai-accent-hover) / <alpha-value>)',
        'nai-text-dim': 'rgb(var(--nai-text-dim) / <alpha-value>)',
        'nai-dark': 'rgb(var(--nai-dark) / <alpha-value>)',
        // 覆盖 Tailwind 默认 gray(默认带蓝调),整体拉回石墨中性
        gray: {
          50: 'rgb(var(--gray-50) / <alpha-value>)',
          100: 'rgb(var(--gray-100) / <alpha-value>)',
          200: 'rgb(var(--gray-200) / <alpha-value>)',
          300: 'rgb(var(--gray-300) / <alpha-value>)',
          400: 'rgb(var(--gray-400) / <alpha-value>)',
          500: 'rgb(var(--gray-500) / <alpha-value>)',
          600: 'rgb(var(--gray-600) / <alpha-value>)',
          700: 'rgb(var(--gray-700) / <alpha-value>)',
          800: 'rgb(var(--gray-800) / <alpha-value>)',
          900: 'rgb(var(--gray-900) / <alpha-value>)',
          950: 'rgb(var(--gray-950) / <alpha-value>)',
        },
      },
      keyframes: {
        'slide-in-from-bottom': {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'slide-in-from-bottom': 'slide-in-from-bottom 0.3s ease-out',
        'fade-in': 'fade-in 0.3s ease-out',
      },
    },
  },
  plugins: [],
}
