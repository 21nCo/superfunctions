import type { DatafnClient, DatafnTable } from "@datafn/client";

export interface Categories {
  color: string;
  createdAt: number;
  id: string;
  name: string;
}

export interface Todos {
  completed: boolean;
  createdAt: number;
  id: string;
  priority?: number;
  text: string;
  updatedAt: number;
}

export interface Tables {
  categories: Categories;
  todos: Todos;
}

export type TypedClient = DatafnClient & {
  categories: DatafnTable<Categories>;
  todos: DatafnTable<Todos>;
};
