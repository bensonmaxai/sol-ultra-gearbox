import { Img, staticFile } from "remotion";

export const QrCode = () => <Img src={staticFile("gearbox-github-qr.svg")} aria-label="QR code for https://github.com/bensonmaxai/sol-ultra-gearbox" style={{ width: 246, height: 246, background: "#F7F9FC", padding: 12, borderRadius: 12 }} />;
