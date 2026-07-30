import esbuild from "esbuild";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const context = await esbuild.context({
  banner: {
    js: "/* Japanese Reading Assistant - generated from TypeScript source */",
  },
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, "src", "main.ts")],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: path.join(projectRoot, "main.js"),
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
