/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'nai-bg': '#0b0f19', // Dark background similar to screenshots
        'nai-panel': '#121624', // Panel background
        'nai-input': '#1c2030', // Input background
        'nai-accent': '#fceda4', // Yellow accent (button)
        'nai-accent-hover': '#ebd576', // Accent hover state
        'nai-text': '#ffffff',
        'nai-text-dim': '#8a8d98',
        'nai-purple': '#6a6afb', // For highlights
        'nai-blue': '#4c5eff',
        'nai-green': '#95e5a5', // NovelAI green
        'nai-dark': '#06080e',
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
