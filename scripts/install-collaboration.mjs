import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const [target, selected] = process.argv.slice(2);
if (!target || !selected || !/^[^/\s]+\/[^/\s]+$/.test(selected)) throw new Error("Usage: node scripts/install-collaboration.mjs <explicit-demo-directory> <available-provider/model>");
const directory = resolve(target);
if (!directory.startsWith(resolve(".runtime") + "/")) throw new Error("Demo installer only writes inside this repository's .runtime/. Global/user configuration is never modified.");
const roles = ["coordinator", "developer", "expert", "tester", "process-designer"];
async function install(path, content) {
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); console.log(`Installed ${path}`); }
  catch (error) { if (error.code !== "EEXIST") throw error; console.log(`Preserved existing ${path}; inspect its model/configuration explicitly.`); }
}
await mkdir(join(directory, ".opencode/agents"), { recursive: true });
for (const role of roles) {
  const text = await readFile(resolve(`resources/agents/teamflow-${role}.md`), "utf8");
  await install(join(directory, `.opencode/agents/teamflow-${role}.md`), text.replace("---\n", `---\nmodel: ${JSON.stringify(selected)}\n`));
}
await mkdir(join(directory, ".opencode/skills/teamflow-collaboration"), { recursive: true });
await install(join(directory, ".opencode/skills/teamflow-collaboration/SKILL.md"), await readFile(resolve("resources/skills/teamflow-collaboration/SKILL.md"), "utf8"));
console.log("Explicit model recorded; adapter checks target backend availability before creating each member. Existing opencode.json(c), agents and skills preserved.");
