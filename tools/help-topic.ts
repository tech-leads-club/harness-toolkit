import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeHome } from "../src/platform/paths.ts";

const docsDir = join(runtimeHome(), "docs");
const topic = (process.argv[2] ?? "").toLowerCase();

/**
 * A topic is a document, or one heading inside one. `section` exists because two topics live inside a larger
 * document and printing the whole of it would bury the answer.
 */
type Topic = { file: string; section?: string };

const TOPICS: Record<string, Topic> = {
  architecture: { file: "architecture.md" },
  concepts: { file: "concepts.md" },
  measure: { file: "measure.md" },
  metrics: { file: "measure.md" },
  prices: { file: "measure.md", section: "## Prices" },
  price: { file: "measure.md", section: "## Prices" },
  cost: { file: "measure.md", section: "## Prices" },
  costs: { file: "measure.md", section: "## Prices" },
  diagnose: { file: "diagnose.md" },
  doctor: { file: "diagnose.md" },
  debug: { file: "diagnose.md" },
  init: { file: "init.md" },
  setup: { file: "init.md" },
  lessons: { file: "lessons.md" },
  lesson: { file: "lessons.md" },
  rules: { file: "concepts.md", section: "## operator rules" },
  rule: { file: "concepts.md", section: "## operator rules" },
  runtime: { file: "concepts.md", section: "## which runtime answers a hook" },
  dev: { file: "concepts.md", section: "## which runtime answers a hook" },
  settings: { file: "concepts.md", section: "## where a setting lives" },
  config: { file: "concepts.md", section: "## where a setting lives" },
};

function printIndex(): void {
  console.log(`tlc harness help

TOPICS
  tlc harness help architecture
  tlc harness help concepts
  tlc harness help lessons
  tlc harness help rules
  tlc harness help settings
  tlc harness help runtime
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

const entry = TOPICS[topic];
if (!entry) {
  console.error(`unknown topic: ${topic}`);
  printIndex();
  process.exit(1);
}

const path = join(docsDir, entry.file);
if (!existsSync(path)) {
  console.error(`missing doc: ${path}`);
  process.exit(1);
}

let body = readFileSync(path, "utf8");
if (entry.section) {
  const idx = body.indexOf(entry.section);
  // why the whole document when the heading is absent: an answer from the wrong version of a doc beats no answer,
  // and the section check already runs in the gate.
  if (idx >= 0) {
    body = body.slice(idx);
  }
}

process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
