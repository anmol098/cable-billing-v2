#!/usr/bin/env node
// Task board CLI. No dependencies; Node >= 20.
//
// The board is the set of tasks/*.md files on the integration branch (see tasks/board.config.json).
// Claims are atomic: a claim is a commit pushed to the integration branch, and git only accepts
// fast-forward pushes, so when two agents race for the same task exactly one push wins.
//
// Usage: node scripts/tasks.mjs <command> [args]   (run `help` for the full list)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUSES = ["todo", "claimed", "blocked", "done"];
const REQUIRED = ["id", "title", "phase", "area", "status", "owner", "claimed_at", "branch", "depends_on", "review", "claimable_by", "size", "paths"];
const TASK_FILE = /^(T-\d{3}|H-\d{2})[a-z]?-.+\.md$/;
const EXIT_UNAVAILABLE = 2;

class BoardError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// ---------- git helpers ----------
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function tryGit(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const repoRoot = () => git(["rev-parse", "--show-toplevel"]);

function config(root) {
  const file = path.join(root, "tasks", "board.config.json");
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return {
    branch: process.env.TASKS_BRANCH || cfg.branch || "feature/mvp",
    remote: process.env.TASKS_REMOTE || cfg.remote || "origin",
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fetchBoard(root, { remote, branch }) {
  const r = tryGit(["fetch", "--quiet", remote, branch], root);
  if (!r.ok) {
    throw new BoardError(
      `Cannot fetch ${remote}/${branch}. Does the integration branch exist?\n` +
        `Ask the coordinator to create it (see tasks/README.md §8).\n${r.out}`,
    );
  }
}

// ---------- parsing ----------
function parse(name, text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new BoardError(`${name}: missing front matter`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    }
    meta[mm[1]] = v;
  }
  return { name, text, meta };
}

function setField(text, key, value) {
  const end = text.indexOf("\n---\n", 4);
  const fm = text.slice(0, end);
  const re = new RegExp(`^${key}:.*$`, "m");
  if (!re.test(fm)) throw new BoardError(`front matter field "${key}" missing`);
  return fm.replace(re, () => (value === "" ? `${key}:` : `${key}: ${value}`)) + text.slice(end);
}

function appendLog(text, line) {
  const header = "## Board log";
  const entry = `- ${new Date().toISOString()} ${line}`;
  if (!text.includes(header)) return `${text.trimEnd()}\n\n${header}\n\n${entry}\n`;
  return `${text.trimEnd()}\n${entry}\n`;
}

// Read tasks either from a directory on disk or from a git ref.
function loadFromDir(dir) {
  const tasksDir = path.join(dir, "tasks");
  return fs
    .readdirSync(tasksDir)
    .filter((f) => TASK_FILE.test(f))
    .sort()
    .map((f) => parse(f, fs.readFileSync(path.join(tasksDir, f), "utf8")));
}
function loadFromRef(root, ref) {
  const names = git(["ls-tree", "--name-only", `${ref}:tasks`], root)
    .split("\n")
    .filter((f) => TASK_FILE.test(f))
    .sort();
  return names.map((f) => parse(f, git(["show", `${ref}:tasks/${f}`], root)));
}

function index(tasks) {
  return new Map(tasks.map((t) => [t.meta.id, t]));
}

function depsDone(task, byId) {
  return (task.meta.depends_on || []).every((d) => byId.get(d)?.meta.status === "done");
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
}

function agentName(args) {
  const explicit = args.agent || process.env.AGENT_ID;
  if (explicit) return explicit;
  const user = tryGit(["config", "user.name"]).out || os.userInfo().username;
  return `${user.replace(/\s+/g, "-")}@${os.hostname()}`;
}

// ---------- atomic board mutation ----------
function mutateBoard(root, cfg, message, mutator) {
  fetchBoard(root, cfg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
  let added = false;
  try {
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (attempt > 1) fetchBoard(root, cfg);
      if (!added) {
        git(["worktree", "add", "--quiet", "--detach", dir, `${cfg.remote}/${cfg.branch}`], root);
        added = true;
      } else {
        git(["reset", "--quiet", "--hard", `${cfg.remote}/${cfg.branch}`], dir);
      }
      const result = mutator(dir); // throws BoardError if the change is no longer valid
      git(["add", ...result.files], dir);
      git(["commit", "--quiet", "--no-verify", "-m", message], dir);
      const push = tryGit(["push", "--quiet", cfg.remote, `HEAD:refs/heads/${cfg.branch}`], dir);
      if (push.ok) return result;
      process.stderr.write(`push rejected (attempt ${attempt}), retrying…\n`);
      sleep(500 * 2 ** attempt + Math.floor(Math.random() * 500));
    }
    throw new BoardError("Could not update the board after 6 attempts. Try again later.");
  } finally {
    if (added) tryGit(["worktree", "remove", "--force", dir], root);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fileFor(dir, id) {
  const f = fs.readdirSync(path.join(dir, "tasks")).find((n) => n.startsWith(`${id}-`) && TASK_FILE.test(n));
  if (!f) throw new BoardError(`Task ${id} not found`);
  return path.join("tasks", f);
}

// ---------- commands ----------
function table(rows) {
  if (!rows.length) return "(none)";
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(w[i])).join("  ");
  return [line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))), ...rows.map(line)].join("\n");
}
const row = (t, byId) => ({
  id: t.meta.id,
  status: t.meta.status,
  ready: t.meta.status === "todo" && depsDone(t, byId) ? "yes" : "",
  phase: t.meta.phase,
  area: t.meta.area,
  size: t.meta.size,
  who: t.meta.claimable_by,
  owner: t.meta.owner || "",
  title: t.meta.title,
});

function loadForRead(root, cfg, args) {
  if (args.local) return loadFromDir(root);
  fetchBoard(root, cfg);
  return loadFromRef(root, `${cfg.remote}/${cfg.branch}`);
}

const commands = {
  help() {
    console.log(`Task board CLI (integration branch from tasks/board.config.json)

  list   [--status S] [--area A] [--phase N] [--owner NAME] [--local]   list tasks
  board  [--local]                                     tasks grouped by status
  next   [--area A] [--local]                          tasks an agent can claim right now
  show   <ID> [--local]                                print a task file
  claim  <ID> [--agent NAME] [--allow-multiple]        atomically claim a task (pushes to the integration branch)
  release <ID> --reason TEXT [--agent NAME] [--force]  give a task back (status → todo)
  block  <ID> --reason TEXT [--agent NAME]             mark a task blocked (keeps owner)
  unblock <ID> [--agent NAME]                          clear blocked status
  complete <ID>                                        set status: done in YOUR worktree (commit it in your PR)
  check  [--local]                                     validate task files (ids, deps, cycles, fields)

Exit codes: 0 ok, 1 error, 2 task not available (already claimed, deps not done, etc).
Env: AGENT_ID (your agent name), TASKS_BRANCH / TASKS_REMOTE (override config).`);
  },

  list(args, root, cfg) {
    const tasks = loadForRead(root, cfg, args);
    const byId = index(tasks);
    const rows = tasks
      .filter((t) => !args.status || t.meta.status === args.status)
      .filter((t) => !args.area || t.meta.area === args.area)
      .filter((t) => !args.phase || t.meta.phase === String(args.phase))
      .filter((t) => !args.owner || t.meta.owner === args.owner)
      .map((t) => row(t, byId));
    console.log(table(rows));
  },

  board(args, root, cfg) {
    const tasks = loadForRead(root, cfg, args);
    const byId = index(tasks);
    for (const s of STATUSES) {
      const group = tasks.filter((t) => t.meta.status === s);
      console.log(`\n## ${s.toUpperCase()} (${group.length})\n`);
      console.log(table(group.map((t) => row(t, byId))));
    }
    const done = tasks.filter((t) => t.meta.status === "done").length;
    console.log(`\nProgress: ${done}/${tasks.length} done`);
  },

  next(args, root, cfg) {
    const tasks = loadForRead(root, cfg, args);
    const byId = index(tasks);
    const unblocks = (id) => tasks.filter((t) => (t.meta.depends_on || []).includes(id)).length;
    const ready = tasks
      .filter((t) => t.meta.status === "todo" && t.meta.claimable_by === "agent" && depsDone(t, byId))
      .filter((t) => !args.area || t.meta.area === args.area)
      .sort((a, b) => Number(a.meta.phase) - Number(b.meta.phase) || unblocks(b.meta.id) - unblocks(a.meta.id) || a.meta.id.localeCompare(b.meta.id))
      .map((t) => ({ ...row(t, byId), unblocks: unblocks(t.meta.id) }));
    console.log(ready.length ? table(ready) : "No claimable tasks right now (all claimed, blocked, waiting on dependencies, or human-only).");
  },

  show(args, root, cfg) {
    const id = args._[0];
    if (!id) throw new BoardError("usage: show <ID>");
    const t = loadForRead(root, cfg, args).find((x) => x.meta.id === id);
    if (!t) throw new BoardError(`Task ${id} not found`);
    console.log(t.text);
  },

  claim(args, root, cfg) {
    const id = args._[0];
    if (!id) throw new BoardError("usage: claim <ID> [--agent NAME]");
    const agent = agentName(args);
    const result = mutateBoard(root, cfg, `board: claim ${id} (${agent})`, (dir) => {
      const tasks = loadFromDir(dir);
      const byId = index(tasks);
      const t = byId.get(id);
      if (!t) throw new BoardError(`Task ${id} not found`);
      if (t.meta.claimable_by !== "agent") throw new BoardError(`${id} is ${t.meta.claimable_by}-only`, EXIT_UNAVAILABLE);
      if (t.meta.status !== "todo") {
        throw new BoardError(`${id} is not available (status: ${t.meta.status}${t.meta.owner ? `, owner: ${t.meta.owner}` : ""})`, EXIT_UNAVAILABLE);
      }
      const missing = (t.meta.depends_on || []).filter((d) => byId.get(d)?.meta.status !== "done");
      if (missing.length) throw new BoardError(`${id} is waiting on: ${missing.join(", ")}`, EXIT_UNAVAILABLE);
      if (!args["allow-multiple"]) {
        const mine = tasks.filter((x) => x.meta.owner === agent && x.meta.status === "claimed");
        if (mine.length) {
          throw new BoardError(`You already hold ${mine.map((x) => x.meta.id).join(", ")}. Finish or release it first (or pass --allow-multiple).`, EXIT_UNAVAILABLE);
        }
      }
      const branch = `task/${id}-${slug(t.meta.title)}`;
      const file = fileFor(dir, id);
      let text = fs.readFileSync(path.join(dir, file), "utf8");
      text = setField(text, "status", "claimed");
      text = setField(text, "owner", agent);
      text = setField(text, "claimed_at", new Date().toISOString());
      text = setField(text, "branch", branch);
      text = appendLog(text, `claimed by ${agent}`);
      fs.writeFileSync(path.join(dir, file), text);
      return { files: [file], branch };
    });
    console.log(`Claimed ${id} as ${agent}.

Next:
  git fetch ${cfg.remote} ${cfg.branch}
  git worktree add ../wt-${id} -b ${result.branch} ${cfg.remote}/${cfg.branch}   # or, if already in an isolated worktree:
  git switch -c ${result.branch} ${cfg.remote}/${cfg.branch}`);
  },

  release(args, root, cfg) {
    const id = args._[0];
    if (!id || !args.reason) throw new BoardError('usage: release <ID> --reason "why" [--force]');
    const agent = agentName(args);
    mutateBoard(root, cfg, `board: release ${id} (${agent})`, (dir) => {
      const file = fileFor(dir, id);
      let text = fs.readFileSync(path.join(dir, file), "utf8");
      const t = parse(file, text);
      if (!["claimed", "blocked"].includes(t.meta.status)) throw new BoardError(`${id} is ${t.meta.status}; nothing to release`, EXIT_UNAVAILABLE);
      if (t.meta.owner && t.meta.owner !== agent && !args.force) {
        throw new BoardError(`${id} is owned by ${t.meta.owner}. Use --force only for stale claims (see tasks/README.md §7).`, EXIT_UNAVAILABLE);
      }
      for (const [k, v] of [["status", "todo"], ["owner", ""], ["claimed_at", ""], ["branch", ""]]) text = setField(text, k, v);
      text = appendLog(text, `released by ${agent}: ${args.reason}`);
      fs.writeFileSync(path.join(dir, file), text);
      return { files: [file] };
    });
    console.log(`Released ${id}.`);
  },

  block(args, root, cfg) {
    const id = args._[0];
    if (!id || !args.reason) throw new BoardError('usage: block <ID> --reason "what is blocking"');
    const agent = agentName(args);
    mutateBoard(root, cfg, `board: block ${id} (${agent})`, (dir) => {
      const file = fileFor(dir, id);
      let text = fs.readFileSync(path.join(dir, file), "utf8");
      text = setField(text, "status", "blocked");
      text = appendLog(text, `blocked by ${agent}: ${args.reason}`);
      fs.writeFileSync(path.join(dir, file), text);
      return { files: [file] };
    });
    console.log(`Marked ${id} blocked.`);
  },

  unblock(args, root, cfg) {
    const id = args._[0];
    if (!id) throw new BoardError("usage: unblock <ID>");
    const agent = agentName(args);
    mutateBoard(root, cfg, `board: unblock ${id} (${agent})`, (dir) => {
      const file = fileFor(dir, id);
      let text = fs.readFileSync(path.join(dir, file), "utf8");
      const t = parse(file, text);
      if (t.meta.status !== "blocked") throw new BoardError(`${id} is not blocked`, EXIT_UNAVAILABLE);
      text = setField(text, "status", t.meta.owner ? "claimed" : "todo");
      text = appendLog(text, `unblocked by ${agent}`);
      fs.writeFileSync(path.join(dir, file), text);
      return { files: [file] };
    });
    console.log(`Unblocked ${id}.`);
  },

  complete(args, root) {
    const id = args._[0];
    if (!id) throw new BoardError("usage: complete <ID>");
    const branch = git(["branch", "--show-current"], root);
    if (!branch.includes(id)) throw new BoardError(`Run this on your task branch (current: ${branch}).`);
    const file = path.join(root, fileFor(root, id));
    let text = fs.readFileSync(file, "utf8");
    text = setField(text, "status", "done");
    text = appendLog(text, `completed on ${branch}`);
    fs.writeFileSync(file, text);
    console.log(`Set ${id} to done in ${path.relative(root, file)}. Commit it as part of your PR; it becomes "done" on the board when the PR merges.`);
  },

  check(args, root, cfg) {
    const tasks = loadForRead(root, cfg, args);
    const errors = [];
    const byId = new Map();
    for (const t of tasks) {
      for (const k of REQUIRED) if (!(k in t.meta)) errors.push(`${t.name}: missing field "${k}"`);
      if (byId.has(t.meta.id)) errors.push(`${t.name}: duplicate id ${t.meta.id}`);
      byId.set(t.meta.id, t);
      if (!t.name.startsWith(`${t.meta.id}-`)) errors.push(`${t.name}: file name must start with "${t.meta.id}-"`);
      if (!STATUSES.includes(t.meta.status)) errors.push(`${t.name}: bad status "${t.meta.status}"`);
      if (!["agent", "human"].includes(t.meta.claimable_by)) errors.push(`${t.name}: claimable_by must be agent|human`);
      if (!["self", "required"].includes(t.meta.review)) errors.push(`${t.name}: review must be self|required`);
      if (t.meta.status === "claimed" && !t.meta.owner) errors.push(`${t.name}: claimed without owner`);
      if (!Array.isArray(t.meta.depends_on)) errors.push(`${t.name}: depends_on must be a [list]`);
    }
    for (const t of tasks) for (const d of t.meta.depends_on || []) if (!byId.has(d)) errors.push(`${t.meta.id}: unknown dependency ${d}`);
    // cycle detection
    const state = new Map();
    const visit = (id, trail) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        errors.push(`dependency cycle: ${[...trail, id].join(" → ")}`);
        return;
      }
      state.set(id, 1);
      for (const d of byId.get(id)?.meta.depends_on || []) if (byId.has(d)) visit(d, [...trail, id]);
      state.set(id, 2);
    };
    for (const id of byId.keys()) visit(id, []);
    if (errors.length) {
      console.error(errors.join("\n"));
      throw new BoardError(`${errors.length} problem(s) in task files`);
    }
    console.log(`OK: ${tasks.length} tasks, no problems.`);
  },
};

// ---------- main ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const [cmd = "help", ...rest] = process.argv.slice(2);
try {
  if (!commands[cmd]) throw new BoardError(`Unknown command "${cmd}". Run: node scripts/tasks.mjs help`);
  const root = repoRoot();
  commands[cmd](parseArgs(rest), root, config(root));
} catch (e) {
  console.error(e instanceof BoardError ? e.message : e.stack || String(e));
  process.exit(e instanceof BoardError ? e.code : 1);
}
