import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  ANSI_ENTER_ALT_SCREEN,
  ANSI_LEAVE_ALT_SCREEN,
  enterAlternateScreen,
  leaveAlternateScreen,
  isAlternateScreenActive,
} from "../src/terminal.js";
import { Writable } from "node:stream";

describe("terminal screen manager", () => {
  let mockOutput: string[] = [];
  let mockStream: NodeJS.WriteStream;

  beforeEach(() => {
    mockOutput = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        mockOutput.push(chunk.toString());
        callback();
      },
    }) as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    mockStream = stream;
    // ensure starting in clean primary buffer state
    leaveAlternateScreen({ stream: mockStream, force: true });
    mockOutput = [];
  });

  afterEach(() => {
    leaveAlternateScreen({ stream: mockStream, force: true });
  });

  test("enters alternate screen buffer on TTY", () => {
    const entered = enterAlternateScreen({ stream: mockStream });
    expect(entered).toBe(true);
    expect(isAlternateScreenActive()).toBe(true);
    expect(mockOutput.join("")).toContain(ANSI_ENTER_ALT_SCREEN);
  });

  test("restores primary screen buffer on leave", () => {
    enterAlternateScreen({ stream: mockStream });
    mockOutput = [];

    const left = leaveAlternateScreen({ stream: mockStream });
    expect(left).toBe(true);
    expect(isAlternateScreenActive()).toBe(false);
    expect(mockOutput.join("")).toContain(ANSI_LEAVE_ALT_SCREEN);
  });

  test("does not enter alternate screen when isTTY is false and not forced", () => {
    (mockStream as any).isTTY = false;
    const entered = enterAlternateScreen({ stream: mockStream });
    expect(entered).toBe(false);
    expect(isAlternateScreenActive()).toBe(false);
    expect(mockOutput.length).toBe(0);
  });

  test("handles consecutive enter and leave idempotently", () => {
    expect(enterAlternateScreen({ stream: mockStream })).toBe(true);
    // second enter while active should not write again
    const secondOutputCount = mockOutput.length;
    expect(enterAlternateScreen({ stream: mockStream })).toBe(true);
    expect(mockOutput.length).toBe(secondOutputCount);

    expect(leaveAlternateScreen({ stream: mockStream })).toBe(true);
    // second leave should return false and not write again
    expect(leaveAlternateScreen({ stream: mockStream })).toBe(false);
  });
});
