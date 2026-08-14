import { describe, expect, test } from "bun:test";
import { startBackgroundCommand, listBackgroundTasks, getBackgroundTask, killBackgroundTask } from "../src/services/background-tasks.js";

describe("background tasks service", () => {
  test("starts, queries status, and lists background command task", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "Start-Sleep -Seconds 10" : "sleep 10";

    const taskId = startBackgroundCommand(cmd);
    expect(taskId).toBeDefined();

    const taskInfo = getBackgroundTask(taskId);
    expect(taskInfo?.status).toBe("running");

    const allTasks = listBackgroundTasks();
    expect(allTasks.some((t) => t.id === taskId)).toBe(true);

    // Kill background task
    const killRes = killBackgroundTask(taskId);
    expect(killRes.success).toBe(true);

    const updatedTask = getBackgroundTask(taskId);
    expect(updatedTask?.status).toBe("killed");
  });
});
