import test from "node:test";
import assert from "node:assert/strict";
import { planAliases, invokeSkill, setupAliases } from "../src/aliases.mjs";

const skill = (id, description = id) => ({ id, name: id, description });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for registry update");
}

test("uses exact resolved IDs, including explicit-only skills", () => {
  const result = planAliases([skill("Mixed.ID"), { id: "manual", autoinvoke: false }], []);
  assert.deepEqual(result.aliases.map((item) => item.id), ["Mixed.ID", "manual"]);
});

test("skips built-in, foreign, configured, and unsupported names", () => {
  const { aliases, skipped } = planAliases([
    skill("skills"), skill("review"), skill("custom"), skill("has space"),
    skill("nested/name"), skill("/bad"), skill("valid"), skill("valid"),
  ], [{ name: "review" }], ["custom"]);
  assert.deepEqual(aliases.map((item) => item.id), ["valid"]);
  assert.equal(skipped.length, 6);
});

function invocationFixture() {
  const calls = [];
  let agent = "plan";
  let available = [skill("check")];
  const ctx = {
    skill: { async list() { return { data: available }; } },
    session: {
      async get() { return { agent }; },
      async prompt(input) { calls.push(["prompt", input]); },
    },
    permission: { async assert(input) { calls.push(["permission", input]); } },
  };
  return { ctx, calls, setAgent(value) { agent = value; }, setSkills(value) { available = value; } };
}

test("checks selected agent permission before submitting a native attachment", async () => {
  const { ctx, calls } = invocationFixture();
  await invokeSkill(ctx, "check", { sessionID: "s", prompt: { text: "review this" }, delivery: "queue" });
  assert.deepEqual(calls, [
    ["permission", { sessionID: "s", agent: "plan", action: "skill", resources: ["check"], save: ["check"] }],
    ["prompt", { sessionID: "s", text: "review this", skills: [{ id: "check" }], delivery: "queue" }],
  ]);
});

test("bare alias preserves empty text without inventing a task", async () => {
  const { ctx, calls } = invocationFixture();
  await invokeSkill(ctx, "check", { sessionID: "s", prompt: { text: "" }, delivery: "steer" });
  assert.equal(calls[1][1].text, "");
});

test("preserves arguments, mentions, files, agents, and other skills without mutation", async () => {
  const { ctx, calls } = invocationFixture();
  const prompt = {
    text: 'check "quoted args"\n/another-skill is literal',
    files: [{ uri: "file:///test/a", mention: { start: 0, end: 2, text: "@a" } }],
    agents: [{ name: "coder" }], skills: [{ id: "other" }],
  };
  const before = structuredClone(prompt);
  await invokeSkill(ctx, "check", { sessionID: "s", prompt, delivery: "steer" });
  assert.deepEqual(prompt, before);
  assert.deepEqual(calls[1][1], { ...prompt, sessionID: "s", delivery: "steer",
    skills: [{ id: "other" }, { id: "check" }] });
});

test("does not duplicate an already attached skill", async () => {
  const { ctx, calls } = invocationFixture();
  const attachment = { id: "check", mention: { start: 0, end: 6, text: "@check" } };
  await invokeSkill(ctx, "check", { sessionID: "s", prompt: { text: "@check", skills: [attachment] } });
  assert.deepEqual(calls[1][1].skills, [attachment]);
});

for (const reason of ["configured deny", "Permission.DeclinedError", "rejected with feedback"]) {
  test(`permission rejection does not submit: ${reason}`, async () => {
    const { ctx, calls } = invocationFixture();
    ctx.permission.assert = async () => { throw new Error(reason); };
    await assert.rejects(invokeSkill(ctx, "check", { sessionID: "s", prompt: { text: "task" } }),
      { message: reason });
    assert.equal(calls.length, 0);
  });
}

test("waits for permission approval before submitting", async () => {
  const { ctx, calls } = invocationFixture();
  let approve;
  ctx.permission.assert = () => new Promise((resolve) => { approve = resolve; });
  const pending = invokeSkill(ctx, "check", { sessionID: "s", prompt: { text: "task" } });
  await until(() => approve);
  assert.equal(calls.length, 0);
  approve();
  await pending;
  assert.equal(calls[0][0], "prompt");
});

test("agent change during permission approval aborts submission", async () => {
  const f = invocationFixture();
  f.ctx.permission.assert = async () => { f.setAgent("build"); };
  await assert.rejects(invokeSkill(f.ctx, "check", { sessionID: "s", prompt: { text: "task" } }), /agent changed/);
  assert.equal(f.calls.length, 0);
});

test("deleted skill aborts before permission or prompt", async () => {
  const f = invocationFixture();
  f.setSkills([]);
  await assert.rejects(invokeSkill(f.ctx, "check", { sessionID: "s", prompt: { text: "task" } }), /no longer available/);
  assert.equal(f.calls.length, 0);
});

test("disabling plugin during approval prevents submission", async () => {
  const f = invocationFixture();
  let live = true;
  f.ctx.permission.assert = async () => { live = false; };
  await assert.rejects(invokeSkill(f.ctx, "check", { sessionID: "s", prompt: { text: "task" } }, () => live),
    /disabled during approval/);
  assert.equal(f.calls.length, 0);
});

function registryFixture() {
  const handlers = new Set();
  const transforms = [];
  const foreign = new Map();
  let skills = [skill("check")];
  let reloads = 0;
  let fail = false;
  function definitions() {
    const map = new Map(foreign);
    for (const fn of transforms) fn({ add(command) { map.set(command.name, command); } });
    return map;
  }
  function emit(type, location = { directory: "/project" }) {
    for (const handler of handlers) handler({ type, location });
  }
  const ctx = {
    ...invocationFixture().ctx,
    options: {}, location: { directory: "/project" },
    skill: { async list() {
      if (fail) throw new Error("registry unavailable");
      return { data: skills };
    } },
    command: {
      async list() { return { data: [...definitions().values()].map(({ name, description }) => ({ name, description })) }; },
      async transform(fn) {
        transforms.push(fn);
        emit("command.updated");
        return { async dispose() { transforms.splice(transforms.indexOf(fn), 1); emit("command.updated"); } };
      },
      async reload() {
        reloads++;
        assert.ok(reloads < 50, "Refresh loop detected");
        definitions();
        // Deliberately deliver self events after the refresh has completed.
        setTimeout(() => emit("command.updated"), 0);
      },
    },
    event: { subscribe({ signal }) {
      const queue = [];
      let wake;
      const push = (event) => { queue.push(event); wake?.(); };
      handlers.add(push);
      const stop = () => wake?.();
      signal.addEventListener("abort", stop, { once: true });
      return (async function* () {
        try {
          while (!signal.aborted) {
            if (!queue.length) await new Promise((resolve) => { wake = resolve; });
            wake = undefined;
            while (queue.length && !signal.aborted) yield queue.shift();
          }
        } finally {
          handlers.delete(push);
          signal.removeEventListener("abort", stop);
        }
      })();
    } },
  };
  return { ctx, definitions, emit, foreign, get reloads() { return reloads; },
    setSkills(value) { skills = value; emit("skill.updated"); },
    setFailure(value) { fail = value; emit("skill.updated"); } };
}

test("initial registration and disposal own only plugin aliases", async () => {
  const f = registryFixture();
  f.foreign.set("custom", { name: "custom", description: "user command" });
  const dispose = await setupAliases(f.ctx);
  assert.ok(f.definitions().has("check"));
  assert.ok(f.definitions().has("custom"));
  await dispose();
  assert.deepEqual([...f.definitions().keys()], ["custom"]);
});

test("refresh adds, removes, and updates aliases without self-event loops", async () => {
  const f = registryFixture();
  const dispose = await setupAliases(f.ctx);
  try {
    f.setSkills([skill("new-skill", "new description")]);
    await until(() => f.definitions().has("new-skill"));
    assert.equal(f.definitions().has("check"), false);
    f.setSkills([skill("new-skill", "changed")]);
    await until(() => f.definitions().get("new-skill")?.description === "Skill: changed");
    const before = f.reloads;
    await delay(350);
    assert.equal(f.reloads, before);
  } finally { await dispose(); }
});

test("foreign command appearing under an alias is revealed and preserved", async () => {
  const f = registryFixture();
  const dispose = await setupAliases(f.ctx);
  try {
    f.foreign.set("check", { name: "check", description: "new user command" });
    // A skills update forces withdrawal, exposing the earlier command.
    f.setSkills([skill("check", "changed")]);
    await until(() => f.definitions().get("check")?.description === "new user command");
  } finally { await dispose(); }
});

test("registry errors withdraw aliases and do not produce a reload loop", async () => {
  const f = registryFixture();
  const dispose = await setupAliases(f.ctx);
  try {
    f.setFailure(true);
    await until(() => !f.definitions().has("check"));
    const before = f.reloads;
    await delay(350);
    assert.equal(f.reloads, before);
    f.setFailure(false);
    await until(() => f.definitions().has("check"));
  } finally { await dispose(); }
});

test("other locations do not refresh this plugin", async () => {
  const f = registryFixture();
  const dispose = await setupAliases(f.ctx);
  try {
    await delay(250);
    const before = f.reloads;
    f.emit("skill.updated", { directory: "/other" });
    await delay(200);
    assert.equal(f.reloads, before);
  } finally { await dispose(); }
});

test("validates configurable reserved names", async () => {
  const f = registryFixture();
  f.ctx.options.reservedNames = "wrong";
  await assert.rejects(setupAliases(f.ctx), /reservedNames/);
});

test("skill changes racing the final registry snapshot are not lost", async () => {
  const f = registryFixture();
  const reload = f.ctx.command.reload;
  let count = 0;
  f.ctx.command.reload = async () => {
    await reload();
    if (++count === 2) f.setSkills([skill("racing-skill")]);
  };
  const dispose = await setupAliases(f.ctx);
  try {
    await until(() => f.definitions().has("racing-skill"));
    assert.equal(f.definitions().has("check"), false);
  } finally { await dispose(); }
});

test("initial discovery failure cleans registration and event subscription", async () => {
  const f = registryFixture();
  f.setFailure(true);
  await assert.rejects(setupAliases(f.ctx), /registry unavailable/);
  assert.equal(f.definitions().size, 0);
});

test("configured reserved names prevent registration", async () => {
  const f = registryFixture();
  f.ctx.options.reservedNames = ["check"];
  const dispose = await setupAliases(f.ctx);
  try { assert.equal(f.definitions().has("check"), false); }
  finally { await dispose(); }
});

test("malformed registry responses fail rather than treating skills as absent", async () => {
  const f = invocationFixture();
  f.ctx.skill.list = async () => [];
  await assert.rejects(invokeSkill(f.ctx, "check", { sessionID: "s", prompt: { text: "task" } }), /data array/);
  assert.equal(f.calls.length, 0);
});

test("disposed aliases cannot submit later", async () => {
  const f = registryFixture();
  const dispose = await setupAliases(f.ctx);
  const alias = f.definitions().get("check");
  await dispose();
  await assert.rejects(alias.execute({ sessionID: "s", prompt: { text: "task" } }), /no longer active/);
});
