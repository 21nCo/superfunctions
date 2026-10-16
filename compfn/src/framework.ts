/**
 * Framework types: Framework, FrameworkRequirement, CreateFrameworkInput.
 */

export interface FrameworkRequirement {
  requirementId: string;
  controlIds: string[];
  name?: string;
}

export interface Framework {
  id: string;
  name: string;
  version?: string;
  description?: string;
  requirements: FrameworkRequirement[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateFrameworkInput {
  name: string;
  version?: string;
  description?: string;
  requirements: FrameworkRequirement[];
}
