import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Agora Classroom",
  description: "Live classroom, cloud recording, and Nemotron transcription demo",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
