export interface TaskOutcomeReconciliationRequest {
  taskId: string;
  claimId: string;
  claimedAt: string;
  /**
   * Opaque integration evidence. The runtime never logs or persists this value;
   * only the configured authority may interpret it.
   */
  evidence: unknown;
}

export interface TaskOutcomeReconciliationDecision {
  /** The external side effect is proven not to have been applied. */
  confirmedNotApplied: boolean;
  /**
   * The prior execution is proven unable to commit in the future (for example,
   * its worker/request is terminal rather than merely absent from a snapshot).
   */
  confirmedQuiescent: boolean;
  /** Non-secret audit reference supplied by the configured authority. */
  authorityReference: string;
  /** SHA-256 of the authority evidence retained outside this runtime. */
  evidenceSha256: string;
}

/**
 * Integration-owned verifier for releasing an ambiguous task tombstone.
 *
 * There is deliberately no permissive built-in implementation. A deployment
 * must bind this interface to provider/worker evidence strong enough to prove
 * both non-application and quiescence of the prior attempt.
 */
export interface TaskOutcomeReconciliationAuthority {
  verifyNotApplied(
    request: Readonly<TaskOutcomeReconciliationRequest>
  ): Promise<Readonly<TaskOutcomeReconciliationDecision>>;
}

export interface TaskOutcomeReconciliationReceipt {
  taskId: string;
  claimId: string;
  claimedAt: string;
  reconciledAt: string;
  authorityReference: string;
  evidenceSha256: string;
  releasedForRetry: true;
}
