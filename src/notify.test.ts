// Tests for the pure terminal-notifier argv assembly: the click-action (-execute) is appended only
// when an execute command is supplied, leaving a plain notification's argv unchanged.
import { test, expect, describe } from "bun:test";
import { notifyArgs } from "./notify.ts";

describe("notifyArgs", () => {
  test("a plain notification carries no -execute", () => {
    const args = notifyArgs("hello");
    expect(args).toContain("-message");
    expect(args).toContain("hello");
    expect(args).not.toContain("-execute");
  });

  test("an execute option appends `-execute <command>`", () => {
    const cmd = "/path/to/bun /repo/src/cli.ts record";
    const args = notifyArgs("Click to record — ignore to skip", { execute: cmd });
    const i = args.indexOf("-execute");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(cmd);
  });

  test("a subtitle option appends `-subtitle <text>`", () => {
    const args = notifyArgs("Click to record — ignore to skip", { subtitle: "Meeting detected" });
    const i = args.indexOf("-subtitle");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("Meeting detected");
  });
});
