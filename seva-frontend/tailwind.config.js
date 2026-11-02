/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
    extend: {
      colors: {
        // SEVA Design System — Consistent Navy-Blue Dark Theme
        navy:   '#0a1128',   // Base dark navy (sidebar, headers)
        deep:   '#050b1a',   // Deepest navy background (body background)
        accent: '#00d9ff',   // Electric cyan — crisp SEVA accent
        panel:  '#0f172a',   // Clean navy-slate for cards and panels
        panelLight: '#16223b', // Elevated card / hover state
        muted:  '#1e2d4a',   // Subtle borders and dividers
        text: {
          primary:   '#f8fafc',  // High-contrast clean white for headings & primary text
          secondary: '#94a3b8',  // Light slate-grey for body and metadata
          muted:     '#64748b',  // Subtle hint text
        }
      },
      fontFamily: {
        sans:    ['Inter', 'sans-serif'],
        heading: ['"Space Grotesk"', 'sans-serif'],
      },
      backgroundImage: {
        'main-gradient': 'linear-gradient(135deg, #050b1a 0%, #0a1128 50%, #0d1a35 100%)',
      }
    },
  },
  plugins: [],
};
