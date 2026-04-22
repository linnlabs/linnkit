interface AgentTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface AgentTodoSnapshot {
  todoListId: string;
  version: number;
  items: AgentTodoItem[];
}
