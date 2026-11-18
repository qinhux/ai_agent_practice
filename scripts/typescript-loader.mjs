// Use the project's existing TypeScript compiler with Node's built-in test runner.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
export function resolve(specifier, context, nextResolve) {
  const candidate = specifier.startsWith("@/") ? new URL(`src/${specifier.slice(2)}`, root)
    : specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : undefined;
  if (candidate?.protocol === "file:") {
    for (const suffix of [".ts", "/index.ts"]) {
      const path = fileURLToPath(candidate) + suffix;
      if (existsSync(path)) return { url: pathToFileURL(path).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  if (url.endsWith(".ts") && !url.includes("/node_modules/")) return {
    format: "module", shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  };
  return nextLoad(url, context);
}
