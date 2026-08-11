import type { TodoItem } from "./types.js";

let currentTodos: TodoItem[] = [];
let todoListeners: ((todos: TodoItem[]) => void)[] = [];

export function getTodos(): TodoItem[] {
  return currentTodos;
}

export function setTodos(todos: TodoItem[]): void {
  currentTodos = todos;
  for (const listener of todoListeners) {
    listener(currentTodos);
  }
}

export function onTodosChange(listener: (todos: TodoItem[]) => void): () => void {
  todoListeners.push(listener);
  return () => {
    todoListeners = todoListeners.filter((l) => l !== listener);
  };
}
