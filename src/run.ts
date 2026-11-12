import { EMPTY_RESPONSE_NOTE, type AgentSession } from "./session.js";
import { killAllBackgroundTasks } from "./services/background-tasks.js";

/** What ask_question gets in a run with nobody to answer. */
export const HEADLESS_ANSWER =
  "Não há ninguém para responder: esta execução é automática (siliconflower run). Decida com o que já sabe, pela opção mais segura, e siga em frente.";

const CLOSE_TIMEOUT_MS = 5_000;

export interface HeadlessResult {
  ok: boolean;
  /** The final answer of the model; empty when the turn failed before any. */
  text: string;
  error: string | null;
  cancelled: boolean;
}

export interface HeadlessOptions {
  /** One line per tool call or warning, for the caller to show outside the answer. */
  onProgress?: (line: string) => void;
}

/**
 * Runs one prompt to the end with no interface: `siliconflower run`, for scripts and CI.
 * Questions to the user are answered with HEADLESS_ANSWER. The caller closes the session
 * (closeHeadless).
 */
export async function runHeadless(session: AgentSession, prompt: string, options: HeadlessOptions = {}): Promise<HeadlessResult> {
  const stopQuestions = session.subscribe((state) => {
    // Outside the listener: answering changes the state again.
    if (state.question) queueMicrotask(() => session.answer(HEADLESS_ANSWER));
  });
  const stopEvents = session.onStreamEvent((event) => {
    if (event.type === "tool_call") options.onProgress?.(`[ferramenta] ${event.name}`);
  });
  try {
    await session.start();
    // The turn clears the error: a failed MCP server would otherwise go unnoticed.
    const startError = session.getState().error;
    if (startError) options.onProgress?.(`[aviso] ${startError}`);

    const before = session.getState().messages.length;
    await session.send(prompt);
    const state = session.getState();
    const cancelled = state.status === "cancelado";
    const last = state.messages.length > before ? state.messages.at(-1) : undefined;
    const text = last?.role === "assistant" ? last.content : "";
    if (cancelled) return { ok: false, text, error: "execução cancelada", cancelled };
    if (state.error) return { ok: false, text, error: state.error, cancelled };
    if (!text || text === EMPTY_RESPONSE_NOTE) {
      return { ok: false, text: "", error: "o modelo encerrou a resposta sem escrever nada", cancelled };
    }
    return { ok: true, text, error: null, cancelled };
  } finally {
    stopQuestions();
    stopEvents();
  }
}

/** Ends the session and what it left running. A hook that never ends must not hold the exit. */
export async function closeHeadless(session: AgentSession): Promise<void> {
  await Promise.race([
    Promise.allSettled([session.close(), killAllBackgroundTasks()]),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);
}
