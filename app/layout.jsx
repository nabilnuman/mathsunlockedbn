import "./globals.css";

export const metadata = {
  title: "MathsUnlockedBN",
  description: "Practice engine for O-Level Maths — MathsUnlockedBN",
};

// Paint the correct theme background on <html> before React hydrates, so
// there's no white flash and no bare-html strip peeking below the app.
const themeBootstrap = `
(function () {
  try {
    var t = localStorage.getItem('mub_theme');
    if (t !== 'light' && t !== 'dark') {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var bg = t === 'dark' ? '#0E1319' : '#F7F9FB';
    var d = document.documentElement;
    d.style.background = bg;
    d.style.colorScheme = t;
    if (document.body) document.body.style.background = bg;
  } catch (e) {}
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
