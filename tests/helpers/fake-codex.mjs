import { chmod, writeFile } from "node:fs/promises";

const SOURCE = `#!/usr/bin/env node
import { chmod, lstat, mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const config = (key) => {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c") continue;
    const value = args[index + 1] ?? "";
    if (value.startsWith(key + "=")) return JSON.parse(value.slice(key.length + 1));
  }
  return null;
};
const cwd = valueAfter("-C");
const prompt = args.at(-1) ?? "";
const marker = /append ([^\\s]+) on a separate final line/.exec(prompt)?.[1] ?? "MISSING_MARKER";
const mode = process.env.FAKE_CODEX_MODE ?? "success";
const auth = await lstat(join(process.env.CODEX_HOME, "auth.json"));
if (!auth.isSymbolicLink() || !/sol-ultra-gearbox-v2-dispatch-home-(luna_clerk|terra_explorer)-/.test(process.env.CODEX_HOME)) process.exit(72);

if (mode === "timeout") {
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(0), 60_000);
}
else {
  if (mode === "write") await writeFile(join(cwd, "fake-write.txt"), "forbidden\\n", "utf8");
  if (mode === "filesystem_mutations") {
    await writeFile(join(cwd, "fake-write.txt"), "forbidden\\n", "utf8");
    await rename(join(cwd, "stable.txt"), join(cwd, "renamed.txt"));
    await unlink(join(cwd, "deleted.txt"));
    await chmod(join(cwd, "chmod.txt"), 0o600);
    await symlink("renamed.txt", join(cwd, "new-link"));
  }
  const sessionRoot = join(process.env.CODEX_HOME, "sessions", "fake");
  await mkdir(sessionRoot, { recursive: true });
  const model = mode === "model_mismatch" ? "gpt-5.6-sol" : config("model");
  const calls = mode === "spawn" ? [{ name: "spawn_agent", arguments: "{}" }] : [];
  const final = mode === "marker_mismatch" ? "WRONG_MARKER" : "{\\\"kind\\\":\\\"fake-deliverable\\\",\\\"value\\\":\\\"verified\\\"}\\n" + marker;
  const events = [
    { type: "session_meta", payload: { id: "fake-root", thread_source: mode === "source_mismatch" ? "subagent" : mode === "source_missing" ? null : "user", cwd } },
    { type: "turn_context", payload: { model, effort: mode === "effort_mismatch" ? "high" : config("model_reasoning_effort"), sandbox_policy: { type: mode === "sandbox_mismatch" ? "workspace-write" : valueAfter("-s") } } },
    ...calls.map((call) => ({ type: "response_item", payload: { type: "function_call", ...call } })),
    ...(mode === "token_missing" ? [] : [{ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 17 } } } }]),
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: final }] } },
  ];
  if (mode === "two_roots") events[0].payload.id = "fake-root-one";
  await writeFile(join(sessionRoot, "rollout.jsonl"), events.map(JSON.stringify).join("\\n"), "utf8");
  if (mode === "two_roots") {
    const extra = structuredClone(events);
    extra[0].payload.id = "fake-root-two";
    await writeFile(join(sessionRoot, "second.jsonl"), extra.map(JSON.stringify).join("\\n"), "utf8");
  }
  if (mode === "malformed") await writeFile(join(sessionRoot, "malformed.jsonl"), "{not json", "utf8");
  if (mode === "pipe_output") process.stdout.write("x".repeat(2 * 1024 * 1024));
}
`;

export async function createFakeCodex(path) {
  await writeFile(path, SOURCE, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}
