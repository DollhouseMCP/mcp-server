import type { SessionActivationState } from '../../state/SessionActivationState.js';

export function restoreSessionDbUserId(
  state: SessionActivationState,
  previousDbUserId: string | undefined,
): void {
  if (previousDbUserId === undefined) {
    delete state.dbUserId;
    return;
  }
  state.dbUserId = previousDbUserId;
}

export function isBridgeOnlySessionActivationState(state: SessionActivationState): boolean {
  return state.personas.size === 0 &&
    state.skills.size === 0 &&
    state.agents.size === 0 &&
    state.memories.size === 0 &&
    state.ensembles.size === 0 &&
    state.userIdentity === undefined &&
    state.dbUserId === undefined &&
    state.activationStore === undefined;
}
