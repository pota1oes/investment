import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy for the published site: scripts only from the site itself,
// network calls only to the Supabase backend. Not applied in dev (hot reload needs inline scripts).
const csp = (): Plugin => ({
  name: "csp",
  apply: "build",
  transformIndexHtml(html) {
    const policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    return html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    );
  },
});

// base "./" makes the build work under any GitHub Pages path (user.github.io/repo/).
export default defineConfig({
  base: "./",
  plugins: [react(), csp()],
  server: { port: 5173 },
});
