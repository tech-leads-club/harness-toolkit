---
type: Runbook
title: "Was that the harness?"
description: "How to tell a harness decision from model behaviour, in the moment and after the fact: the one command that answers it, what each rule name means, and the four symptoms that are not the harness at all."
tags: [troubleshooting, rules, observability]
timestamp: "2026-08-12"
---

# Was that the harness?

> "eu to meio perdido tentando entender o que é comportamento do harness toolkit, o que é loucura do modelo"

Hooks are invisible by construction: the harness answers the editor, and the editor decides whether to show
you. This page is how you find out anyway.

## The one command

```bash
tlc harness why
```

The last ten decisions the tool made, newest first, each with the rule behind it:

```
Last 4 harness decision(s), newest first:

19:23:05  shell          deny    rule=policy-surface-write
          python3 -c "open('.tlc/harness/config.json','w')"
19:23:05  shell          ask     rule=shell-catastrophic
          dd if=/dev/zero of=/dev/sda
19:23:05  tool.before    deny    rule=subagent-allowlist
          Task
19:23:05  session start  context rule=unattributed
          4210 chars injected
```

**And when it was not the harness, it says so:**

```
No harness decision in this window.
Whatever you just saw was the model, not a rail — the harness allowed everything it was asked about.
```

That sentence is the point of the command. `tlc harness why 30` widens the window; `--json` gives the same
records as data.

## The rule names

Every refusal names one. The name is the pointer — the reasoning lives in the decision record it cites.

| Rule | What refused, and why |
| --- | --- |
| `outside-project-destruction` | a destructive command aimed outside the repo and outside the temp directory |
| `unprovable-destruction` | a destructive verb whose target is built at runtime, so the harness cannot see what it would delete |
| `unprovable-execution` | a program fetched over the network and handed to a shell, so the harness cannot read what would run |
| `secret-access` | a read that would copy credentials into the transcript, from a file **or** from the instance metadata service |
| `history-rewrite` | `git push --force`. `--force-with-lease` is allowed |
| `machine-control` | `shutdown`, `reboot`, `halt`, `poweroff` |
| `policy-surface-write` | any route an agent has to harness policy or state |
| `policy-baseline-divergence` | a policy file changed mid-session with no `tlc harness` command behind it |
| `edit-collision` | another live session touched this file recently |
| `shell-catastrophic` | a shell command that can destroy data outside the workspace |
| `shell-posture-paired` | the `paired` posture asks before a command that leaves the machine or can overwrite a path |
| `shell-stall` | the same shell command repeated past the threshold |
| `subagent-allowlist` | the model is not on `subagents.allowedModels` |
| `subagent-parent-fast` | the parent chat is in Fast mode |
| `subagent-blocked-pattern` | the model matched a blocked shape, `*-fast` by default |
| `subagent-model-required` | the spawn named no model and `requireModel` is on |
| `subagent-min-effort` | the spawn's effort is below `minEffort` |
| `subagent-read-only` | a read-only subagent type reached for a writing tool |
| `rewrite-unavailable` | the provider cannot rewrite tool input, so the harness asked instead |
| `unattributed` | a record written before rules were required. It will not appear for new decisions |

## Four things that are **not** the harness

**A message with no `rule=`, no `BLOCKED:` and no `FLOOR:`.** Every harness decision carries one of the three.

**A subagent model changing.** The harness does not change models. It refuses a spawn, with
`rule=subagent-allowlist`, and the refusal goes to the model as `agent_message` and to you as `user_message`.
If your editor renders neither, `tlc harness why` still shows it.

**A gate failing here but passing in your terminal.** From the second attempt the follow-up says so itself, and
names the variables the hook set. It is usually the project's gate command differing from the one your suite
needs — which only you can change:

```bash
tlc harness gate test-command <your real test command>
```

**Everything, when the harness is off for this repo.** `tlc harness doctor` lists which rails are on.

## After the fact

| Command | Answers |
| --- | --- |
| `tlc harness why [n]` | the last n decisions, with rules — **start here** |
| `tlc harness obs report` | this session: gate outcomes, refusals by rule, interruptions by rule, cost |
| `tlc harness obs live` | the same signal as it happens |
| `tlc harness doctor` | which rails are on, and which are on but enforcing nothing |
| `tlc harness handoff` | what the last turn left open |
| `tlc harness attest` | one hash-chained record per session, for a reviewer |

## When a refusal is wrong

Say so in your reply and let the operator decide. Working around a floor rule is not a fix — the six of them
read no configuration precisely so that nothing in a session can clear them
([/decisions/ad-016.md](/decisions/ad-016.md)).

For a rail, the operator changes it from their own terminal, outside the agent session
([/decisions/ad-022.md](/decisions/ad-022.md)):

```bash
tlc harness mode solo          # leave the paired posture
tlc harness pause              # disable stop checks while exploring
tlc harness policy accept --all  # after you edited config mid-session
```

## When you want it off entirely

```bash
tlc harness uninstall          # the plan, and nothing else
tlc harness uninstall --yes    # apply it
```

It un-merges the hook groups out of `settings.json` and leaves every other key alone, so this is the
supported alternative to editing that file by hand. `config.json` and `state/` survive unless you add
`--purge`.

**An agent cannot do this for you**, and the refusal is not a defect. The runtime home sits outside any
project and `state/` is a policy surface, so a delegated uninstall meets `outside-project-destruction` or
`policy-surface-write` ([/decisions/ad-066.md](/decisions/ad-066.md)). Run it from your own terminal.

## See also

- [/concepts.md](/concepts.md) — every rail from the operator's side
- [/diagnose.md](/diagnose.md) — hooks not firing, stale runtime, cost showing null
- [/decisions/index.md](/decisions/index.md) — why each rule exists
