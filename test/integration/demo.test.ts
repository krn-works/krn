import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("npm run demo passes all three deterministic scenarios", () => {
  const output = execFileSync("npm", ["run", "demo"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  console.info(output.trimEnd());
  expect(output).toContain("All three deterministic demo scenarios passed.");
}, 30000);
