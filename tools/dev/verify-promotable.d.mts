export type PromotionProbes = {
  publishedOnNpm: (pkg: string, version: string) => boolean;
  gitTagExists: (tag: string) => boolean;
  releaseExists: (tag: string) => boolean;
};

export function defaultProbes(): PromotionProbes;
export function tagFor(version: string): string;
export function promotionProblems(pkg: string, version: string, probes: PromotionProbes): string[];
