import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitJson, takeJsonFlag } from "../../src/platform/cli-output.ts";

export type TriggerCase = {
  query: string;
  should_trigger: boolean;
  phrase?: string;
  note?: string;
};

export type RoutingAnswer = { query: string; triggered: boolean | null };

export type EvalFailure = {
  query: string;
  expected: boolean;
  actual: boolean | null;
  note?: string;
};

export type EvalOutcome = {
  total: number;
  passed: number;
  failed: number;
  unanswered: number;
  passRate: number;
  failures: EvalFailure[];
};

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_THRESHOLD = 0.9;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillDir = join(repoRoot, "skills", "harness-init");

export function loadCases(dir = skillDir): TriggerCase[] {
  return JSON.parse(readFileSync(join(dir, "evals", "trigger_evals.json"), "utf8")) as TriggerCase[];
}

export function skillFrontmatter(dir = skillDir): { name: string; description: string } {
  const front = readFileSync(join(dir, "SKILL.md"), "utf8").split("---")[1] ?? "";
  const name = /name:\s*(\S+)/.exec(front)?.[1] ?? "";
  const description = /description:\s*([\s\S]*?)(?:\nlicense:|\nmetadata:|$)/
    .exec(front)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  return { name, description: description ?? "" };
}

export function buildRoutingPrompt(skill: { name: string; description: string }, query: string): string {
  return [
    "You route user requests to skills. One skill is available:",
    "",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "",
    "A user says:",
    `"${query}"`,
    "",
    `Would you load the ${skill.name} skill to handle this request?`,
    "Answer with exactly one word: YES or NO.",
  ].join("\n");
}

export function parseVerdict(text: string): boolean | null {
  const normalized = text.trim().toUpperCase();
  if (normalized.startsWith("YES")) {
    return true;
  }
  if (normalized.startsWith("NO")) {
    return false;
  }
  return null;
}

export function scoreAnswers(cases: readonly TriggerCase[], answers: readonly RoutingAnswer[]): EvalOutcome {
  const byQuery = new Map(answers.map((answer) => [answer.query, answer.triggered]));
  const failures: EvalFailure[] = [];
  let passed = 0;
  let unanswered = 0;
  for (const testCase of cases) {
    const actual = byQuery.get(testCase.query) ?? null;
    if (actual === null) {
      unanswered += 1;
      failures.push({
        query: testCase.query,
        expected: testCase.should_trigger,
        actual,
        note: testCase.note,
      });
      continue;
    }
    if (actual === testCase.should_trigger) {
      passed += 1;
      continue;
    }
    failures.push({ query: testCase.query, expected: testCase.should_trigger, actual, note: testCase.note });
  }
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    unanswered,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    failures,
  };
}

export function apiKeyFrom(env: Record<string, string | undefined>): string | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function modelFrom(argv: readonly string[]): string {
  const index = argv.indexOf("--model");
  return index >= 0 ? (argv[index + 1] ?? DEFAULT_MODEL) : DEFAULT_MODEL;
}

async function askModel(prompt: string, model: string, apiKey: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`anthropic api ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { content?: { text?: string }[] };
  return body.content?.[0]?.text ?? "";
}

async function main(argv: string[]): Promise<void> {
  const { json, rest } = takeJsonFlag(argv);
  const apiKey = apiKeyFrom(process.env);
  if (!apiKey) {
    const reason =
      "ANTHROPIC_API_KEY is not set — skipping the routing eval (the cases themselves are gated by the test suite)";
    if (json) {
      emitJson({ skipped: true, reason });
    } else {
      console.log(reason);
    }
    process.exit(0);
  }

  const model = modelFrom(rest);
  const skill = skillFrontmatter();
  const cases = loadCases();
  const answers: RoutingAnswer[] = [];
  for (const testCase of cases) {
    const text = await askModel(buildRoutingPrompt(skill, testCase.query), model, apiKey);
    answers.push({ query: testCase.query, triggered: parseVerdict(text) });
  }

  const outcome = scoreAnswers(cases, answers);
  if (json) {
    emitJson({ model, threshold: DEFAULT_THRESHOLD, ...outcome });
  } else {
    console.log(`model=${model} pass=${outcome.passed}/${outcome.total} rate=${outcome.passRate.toFixed(3)}`);
    for (const failure of outcome.failures) {
      console.log(`  MISROUTED expected=${failure.expected} actual=${failure.actual} — ${failure.query}`);
    }
  }
  process.exit(outcome.passRate >= DEFAULT_THRESHOLD ? 0 : 1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
