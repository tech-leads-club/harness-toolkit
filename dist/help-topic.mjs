// tools/help-topic.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/platform/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function conventionalRuntimeHome() {
  return join(homedir(), ".tlc", "harness");
}
function runtimeHome(env = process.env) {
  return env.TLC_HOME ?? conventionalRuntimeHome();
}

// tools/help-topic.ts
var docsDir = join2(runtimeHome(), "docs");
var topic = (process.argv[2] ?? "").toLowerCase();
var TOPICS = {
  architecture: "architecture.md",
  concepts: "concepts.md",
  measure: "measure.md",
  metrics: "measure.md",
  prices: "measure.md",
  price: "measure.md",
  cost: "measure.md",
  costs: "measure.md",
  diagnose: "diagnose.md",
  doctor: "diagnose.md",
  debug: "diagnose.md",
  init: "init.md",
  setup: "init.md",
  lessons: "lessons.md",
  lesson: "lessons.md"
};
function printIndex() {
  console.log(`tlc harness help

TOPICS
  tlc harness help architecture
  tlc harness help concepts
  tlc harness help lessons
  tlc harness help measure
  tlc harness help prices
  tlc harness help diagnose
  tlc harness help init

PRICES
  tlc harness prices refresh [all|cursor|litellm]
  tlc harness prices lookup <model-id>

ALSO
  tlc harness status | doctor | grind | mode | obs | lessons
`);
}
if (!topic || topic === "help" || topic === "-h" || topic === "--help") {
  printIndex();
  process.exit(0);
}
var file = TOPICS[topic];
if (!file) {
  console.error(`unknown topic: ${topic}`);
  printIndex();
  process.exit(1);
}
var path = join2(docsDir, file);
if (!existsSync(path)) {
  console.error(`missing doc: ${path}`);
  process.exit(1);
}
var body = readFileSync(path, "utf8");
if (topic === "prices" || topic === "price" || topic === "cost" || topic === "costs") {
  const marker = "## Prices";
  const idx = body.indexOf(marker);
  if (idx >= 0) {
    body = `# Prices

${body.slice(idx)}`;
  }
}
process.stdout.write(body.endsWith(`
`) ? body : `${body}
`);
