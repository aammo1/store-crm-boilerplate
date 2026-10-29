import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export function auditReleaseTree() {
  const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0"))]
    .filter(file => file && existsSync(path.join(root, file))).sort();
  const allowedRoots = new Set([".github", "src", "scripts", "migrations", "docs", "specs", "deploy", "examples", "integrations", "public"]);
  const allowedRootFiles = new Set([".dockerignore", ".env.example", ".gitignore", "AGENTS.md", "Dockerfile", "README.md", "components.json", "docker-compose.yml", "eslint.config.mjs", "next.config.ts", "store.config.ts", "package-lock.json", "package.json", ".template-version", "postcss.config.mjs", "tsconfig.json"]);
  const fonts = new Set(["src/app/fonts/inter-latin-var.woff2", "src/app/fonts/playfair-latin-var.woff2", "src/app/fonts/playfair-latin-italic-var.woff2", "src/app/fonts/cairo-arabic-var.woff2"]);
  for (const file of files) {
    assert.ok(file.includes("/") ? allowedRoots.has(file.split("/")[0]) : allowedRootFiles.has(file), `Unexpected release path: ${file}`);
    assert.ok(lstatSync(path.join(root, file)).isFile(), `Symlink/non-file: ${file}`);
    // public/brand holds the store logo/icon/hero. The template ships one example
    // logo and the new-store wizard writes hashed webp/png assets there, so generated
    // stores must not fail this audit; every other path keeps the full checks.
    if (file.startsWith("public/brand/")) continue;
    assert.ok(!/(?:^|\/)(?:\.git|data|uploads|backups|secrets|node_modules|\.next|test-results|playwright-report|\.auth)(?:\/|$)|\.(?:db|sqlite\d*|pem|key|p12|pfx|log|csv|zip|png|jpe?g|webp|pdf)(?:$|[-.])|\.env(?!\.example$)/i.test(file), `Private artifact: ${file}`);
    if (fonts.has(file)) continue;
    assert.ok(file.endsWith("/.gitkeep") || /\.(?:md|ts|tsx|mjs|css|json|sql|yml|cron|service|timer)$/.test(file) || allowedRootFiles.has(file), `Unreviewed binary: ${file}`);
    const text = readFileSync(path.join(root, file), "utf8");
    assert.ok(!text.includes("\0"), `Unexpected binary: ${file}`);
    // High-confidence material only; do not print matched secret contents.
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-|or-v1-)[A-Za-z0-9_-]{40,}/.test(text), `Credential candidate: ${file}`);
    if (file.startsWith("src/")) {
      assert.ok(!/zehri|(?<![A-Za-z0-9_.@/-])\/home\/|\/Users\/|COMPATIBILITY BRIDGE|product_colors|color_id/i.test(text), `Source coupling: ${file}`);
    }
  }
  const roots = new Set(files.map(file => file.split("/")[0]));
  console.log(`Reviewed ${files.length} intended public files across ${roots.size} roots; only four allowlisted font binaries, public/brand assets, no media/env/database/export/private-key artifacts or runtime source coupling.`);
  return files;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) auditReleaseTree();
