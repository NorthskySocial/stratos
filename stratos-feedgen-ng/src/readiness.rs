/// Read-side admission control shared with the TypeScript FeedReadinessGate.
///
/// Feed reads start closed. A current service-stream session and a complete,
/// error-free reconciliation are both required before the gate opens.
#[derive(Debug, Default)]
pub struct FeedReadinessGate {
    ready: bool,
    generation: u64,
    has_authoritative_session: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReconciliationOutcome {
    pub errors: u32,
    pub truncated: bool,
}

impl FeedReadinessGate {
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn has_authoritative_session(&self) -> bool {
        self.has_authoritative_session
    }

    pub fn mark_unavailable(&mut self) {
        self.ready = false;
        self.has_authoritative_session = false;
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn mark_session_established(&mut self) {
        self.mark_unavailable();
        self.has_authoritative_session = true;
    }

    pub fn begin_reconciliation(&mut self) -> u64 {
        self.ready = false;
        self.generation
    }

    pub fn complete_reconciliation(
        &mut self,
        generation: u64,
        outcome: ReconciliationOutcome,
    ) -> bool {
        if !self.has_authoritative_session
            || generation != self.generation
            || outcome.errors > 0
            || outcome.truncated
        {
            return false;
        }

        self.ready = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{FeedReadinessGate, ReconciliationOutcome};

    #[test]
    fn starts_closed_until_the_current_session_reconciles() {
        let mut gate = FeedReadinessGate::default();
        assert!(!gate.is_ready());

        let before_session = gate.begin_reconciliation();
        assert!(!gate.complete_reconciliation(
            before_session,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));

        gate.mark_session_established();
        assert!(gate.has_authoritative_session());
        let current_session = gate.begin_reconciliation();
        assert!(gate.complete_reconciliation(
            current_session,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(gate.is_ready());
    }

    #[test]
    fn rejects_incomplete_and_superseded_reconciliations() {
        let mut gate = FeedReadinessGate::default();
        gate.mark_session_established();

        let failed = gate.begin_reconciliation();
        assert!(!gate.complete_reconciliation(
            failed,
            ReconciliationOutcome {
                errors: 1,
                truncated: false,
            },
        ));

        let stale = gate.begin_reconciliation();
        gate.mark_unavailable();
        assert!(!gate.has_authoritative_session());
        assert!(!gate.complete_reconciliation(
            stale,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(!gate.is_ready());
    }
}
