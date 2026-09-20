/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
    extend: {
      colors: {
        // SEVA Design System — defined ONCE here, used by name everywhere
        navy:   '#0a1128',   // Base dark background
        deep:   '#050b1a',   // Darkest layer (body background)
        accent: '#00d9ff',   // Electric cyan — SEVA signature color
        panel:  '#111827',   // Slightly lighter for cards/panels
        muted:  '#1e2d4a',   // Muted navy for borders and subtle fills
        text: {
          primary:   '#f0f6ff',  // Near-white for headings
          secondary: '#8899bb',  // Muted blue-grey for body
        }
      },
      fontFamily: {
        sans:    ['Inter', 'sans-serif'],
        heading: ['"Space Grotesk"', 'sans-serif'],
      },
      boxShadow: {
        'accent-glow':  '0 0 20px rgba(0, 217, 255, 0.3)',
        'accent-glow-sm': '0 0 10px rgba(0, 217, 255, 0.2)',
      },
      backgroundImage: {
        'main-gradient': 'linear-gradient(135deg, #050b1a 0%, #0a1128 50%, #0d1a35 100%)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      }
    },
  },
  plugins: [],
};
