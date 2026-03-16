import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Superfunctions";
export const size = {
  width: 1200,
  height: 630,
};

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 45%, #0b3a2a 100%)",
          color: "#f8fafc",
          fontSize: 56,
          fontWeight: 700,
        }}
      >
        Superfunctions
      </div>
    ),
    size,
  );
}
