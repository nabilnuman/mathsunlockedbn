export default function manifest() {
  return {
    name: "MathsUnlockedBN — O-Level Maths",
    short_name: "MathsUnlocked",
    description:
      "Gamified practice for Cambridge O-Level Maths (4024) — Brunei. Streaks, levels, class homework and challenges.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F7F9FB",
    theme_color: "#3B6FA0",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
