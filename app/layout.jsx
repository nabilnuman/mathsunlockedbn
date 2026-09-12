import "./globals.css";

export const metadata = {
  title: "MathsUnlockedBN",
  description: "Practice engine for O-Level Maths — MathsUnlockedBN",
  manifest: "/manifest.webmanifest",
  applicationName: "MathsUnlocked",
  appleWebApp: { capable: true, title: "MathsUnlocked", statusBarStyle: "default" },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport = {
  themeColor: "#3B6FA0",
};

// Paint the correct theme background on <html> before React hydrates, so
// there's no white flash and no bare-html strip peeking below the app.
// Mirrors THEMES' --page-bg / dark-family flag in MathsUnlockedBN.jsx — if
// a new appearance is added there, add its page-bg + dark-ness here too.
const themeBootstrap = `
(function () {
  try {
    var PAGE_BG = {
      light: '#F7F9FB', dark: '#0E1319', mint: '#F1FAF5', sky: '#F1F7FD',
      dots: '#EFF3F7', blueprint: '#0E2038', sunset: '#FDF3EC', slate: '#232C38',
      stripes: '#EFF3F7', aurora: '#F5F5FC', gold: '#FBF3E2', arcade: '#170B2E'
    };
    var DARK_FAMILY = { dark: 1, blueprint: 1, slate: 1, arcade: 1 };
    var t = localStorage.getItem('mub_theme');
    if (!PAGE_BG.hasOwnProperty(t)) {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var bg = PAGE_BG[t];
    var d = document.documentElement;
    d.style.background = bg;
    d.style.colorScheme = DARK_FAMILY[t] ? 'dark' : 'light';
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
