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

Subagents is tested with Pi 1.0.0. Host libraries are peers and aren't bundled. No skills ship yet.

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

The probes confirm an upstream limitation in Pi 1.0.0: after a tool quietly terminates a run, an RPC abort while idle isn't observable through public extension events or abort signals. A later result-ready notification can still wake the model. Quiet waiting with automatic resumption and explicit idle-abort suppression therefore isn't implemented here. The current completion behavior remains unchanged.

Put small extensions in `extensions/<name>.ts` and multi-file extensions in `extensions/<name>/index.ts`. Add each entry point to `pi.extensions` in `package.json`; supporting modules must not load independently.

Add skills as `skills/<name>/SKILL.md`, with `name` and `description` frontmatter. The package already declares the skills directory.

Run `pnpm pack --pack-destination /tmp` to inspect the distributable package. TypeScript source ships directly; there's no build step.
