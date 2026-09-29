/**
 * Client build for the standalone Fast Temp Mail export.
 * Bun-native: compiles client/src/main.tsx into client/dist with Tailwind.
 * Usage: `bun ./client/build.mjs`
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "src", "main.tsx");
const outDir = join(here, "dist");


if (!existsSync(entry)) {
  console.error(`Entry not found: ${entry}`);
  process.exit(1);
}


mkdirSync(outDir, { recursive: true });


const result = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  naming: "[name].[ext]",
  target: "browser",
  format: "esm",
  sourcemap: "external",
  minify: process.env.NODE_ENV === "production",
  splitting: true,
  plugins: [(await import("bun-plugin-tailwind")).default],
});


if (!result.success) {
  console.error("Client build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}


// Static files served as-is by the server.
const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#05070d" />
    <meta name="description" content="Fast Temp Mail — instant temporary email with accounts, wallets and plans." />
    <link rel="icon" type="image/png" href="/logo.png" />
    <title>Fast Temp Mail</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`;
writeFileSync(join(outDir, "index.html"), indexHtml);


const logo = join(here, "src", "assets", "fast-temp-mail-logo.png");
if (existsSync(logo)) cpSync(logo, join(outDir, "logo.png"));


console.log(`Client build ok → ${outDir}`);

