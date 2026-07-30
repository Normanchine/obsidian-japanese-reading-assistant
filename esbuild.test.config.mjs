import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

await esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, "src", "core.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(projectRoot, "tests", ".generated", "core.mjs"),
  sourcemap: false,
});
