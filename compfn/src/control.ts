/**
 * Control types: Control, CreateControlInput, UpdateControlInput.
 */

export interface Control {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateControlInput {
  name: string;
  description: string;
  category: string;
  tags?: string[];
}

export interface UpdateControlInput {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
}
