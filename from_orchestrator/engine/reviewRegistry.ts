export interface HumanReviewResult {
  decision: 'APPROVED' | 'EDITED' | 'REJECTED';
  editedContent?: string;
}

class ReviewRegistry {
  private pendingReviews = new Map<string, {
    resolve: (result: HumanReviewResult) => void;
    reject: (error: Error) => void;
  }>();

  private getReviewKey(runId: string, nodeId: string): string {
    return `${runId}::${nodeId}`;
  }

  public registerReview(runId: string, nodeId: string): Promise<HumanReviewResult> {
    const key = this.getReviewKey(runId, nodeId);
    return new Promise<HumanReviewResult>((resolve, reject) => {
      this.pendingReviews.set(key, { resolve, reject });
    });
  }

  public resolveReview(runId: string, nodeId: string, result: HumanReviewResult): boolean {
    const key = this.getReviewKey(runId, nodeId);
    const pending = this.pendingReviews.get(key);
    if (pending) {
      pending.resolve(result);
      this.pendingReviews.delete(key);
      return true;
    }
    return false;
  }

  public rejectReview(runId: string, nodeId: string, error: Error): boolean {
    const key = this.getReviewKey(runId, nodeId);
    const pending = this.pendingReviews.get(key);
    if (pending) {
      pending.reject(error);
      this.pendingReviews.delete(key);
      return true;
    }
    return false;
  }
}

export const reviewRegistry = new ReviewRegistry();
