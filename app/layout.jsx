import "./globals.css";

export const metadata = {
  title: "MathsUnlockedBN",
  description: "Practice engine for O-Level Maths — MathsUnlockedBN",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
