import "./globals.css";

export const metadata = {
  title: "안전컨설팅 자동화",
  description: "안전상생 컨설팅 업무자동화",
};

export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
