import { DBService } from '../db/database.ts';
import type { FailureCode } from './failures.ts';
import type { RunStatus } from './statuses.ts';

export interface RunPersistence {
  createRun(runId: string, topic: string): void;
  updateRunStatusIfNotTerminal(runId: string, status: RunStatus): boolean;
}

export interface TaskPersistence extends RunPersistence {
  createTask(params: {
    taskId: string;
    runId: string;
    providerName: string;
    promptPayload: string;
    status: string;
    attemptNo?: number;
  }): void;
  updateTaskResponse(params: {
    taskId: string;
    responseText: string;
    extractionMethod: 'clean' | 'timeout_forced' | 'manual' | 'api';
    status: string;
  }): void;
  updateTaskStatus(taskId: string, status: string): void;
  markTaskSubmissionConfirmed(taskId: string): void;
  failTaskWithClassification(
    taskId: string,
    status: 'FAILED' | 'CANCELLED' | 'INTERVENTION_REQUIRED',
    failureCode: FailureCode,
    submissionConfirmed: boolean
  ): void;
  addTelemetry(params: {
    taskId: string;
    stateFrom: string;
    stateTo: string;
    durationMs: number | null;
  }): void;
}

export const sqlitePersistence: TaskPersistence = {
  createRun: (runId, topic) => DBService.createRun(runId, topic),
  updateRunStatusIfNotTerminal: (runId, status) => DBService.updateRunStatusIfNotTerminal(runId, status),
  createTask: params => DBService.createTask(params),
  updateTaskResponse: params => DBService.updateTaskResponse(params),
  updateTaskStatus: (taskId, status) => DBService.updateTaskStatus(taskId, status),
  markTaskSubmissionConfirmed: taskId => DBService.markTaskSubmissionConfirmed(taskId),
  failTaskWithClassification: (taskId, status, failureCode, submissionConfirmed) => {
    DBService.failTaskWithClassification(taskId, status, failureCode, submissionConfirmed);
  },
  addTelemetry: params => DBService.addTelemetry(params)
};
