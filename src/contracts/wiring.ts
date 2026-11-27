export type RuntimePaths = {
  launcherPath: string;
};

export type WiringEntry = {
  hookEvent: string;
  handler: string;
  command: string;
  args: string[];
  timeoutSeconds: number;
  failClosed?: boolean;
  matcher?: string;
  loopLimit?: number;
};

export type ProviderWiring = {
  target: string;
  strategy: "replace" | "merge";
  commandFormat?: "shell";
  entries: WiringEntry[];
};
