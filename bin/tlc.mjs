#!/usr/bin/env node
// why: npm's bin shim invokes its target with node on every platform, so the bash wrapper `bin/tlc` cannot be
// the published entry — a shell script behind a generated .cmd is the classic broken global install on Windows.
// The two wrappers stay for the git-clone route, which puts them on PATH directly.
import { main } from "./tlc-exec.mjs";

main([process.argv[0] ?? "node", process.argv[1] ?? "tlc", "tlc-cli", ...process.argv.slice(2)]);
