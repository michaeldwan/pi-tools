# pi-tools

Pi extensions and skills maintained by Michael Dwan. One package, with explicit extension entry points and skills under `skills/`.

## Install

From a local checkout:

```sh
pi install /absolute/path/to/pi-tools
```

To try it for one session without changing your settings:

```sh
pi -e /absolute/path/to/pi-tools
```

Run `pi config` to enable or disable individual resources. Extensions execute with your operating-system permissions; review their source before installing.

## Extensions

- [Subagents](extensions/subagents/README.md) -- run independent Pi RPC workers, inspect results, steer or stop them, and view their conversations with `/subagents`.

Subagents requires Pi 1.0.0 or newer; 1.0.0 is the tested minimum. Host libraries are peers and aren't bundled. No skills ship yet.

## Development

Requires Node.js 22.19 or newer and pnpm.

```sh
pnpm install --ignore-scripts
pnpm run check
```

Tests run isolated Pi instances with deterministic providers. They don't need credentials and don't use your real agent directory. Development types are pinned to Pi 1.0.0.

`test/subagents/host.test.ts` probes quiet tool termination, hidden ready notifications, child usage collection and idle abort visibility. Run it against an installed host without changing your settings:

```sh
PI_TEST_HOST=/absolute/path/to/pi node --experimental-strip-types --test test/subagents/host.test.ts
```

Background results prompt one collection call automatically; `wait_for_subagents` quietly yields when workers are still busy. `/subagents pause` and `/subagents resume` control automatic processing without stopping workers. Pause persists across reload/restart and isn't undone by ordinary input.

The host probes retain evidence of a Pi 1.0.0 limitation: idle Esc/RPC abort isn't observable through public extension events or abort signals. It doesn't pause arrivals -- use `/subagents pause`. Tests in `delivery.test.ts` and `waiting.test.ts` exercise the implemented delivery, recovery, accounting and pause controls through real RPC. Set `PI_TEST_HOST` to run them against an installed host too.

Put small extensions in `extensions/<name>.ts` and multi-file extensions in `extensions/<name>/index.ts`. Add each entry point to `pi.extensions` in `package.json`; supporting modules must not load independently.

Add skills as `skills/<name>/SKILL.md`, with `name` and `description` frontmatter. The package already declares the skills directory.

Run `pnpm pack --pack-destination /tmp` to inspect the distributable package. TypeScript source ships directly; there's no build step.
