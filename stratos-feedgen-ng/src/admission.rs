use std::collections::HashMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadToken {
    session_epoch: u64,
    viewer: String,
    viewer_epoch: u64,
    boundary: String,
    boundary_epoch: u64,
    projection_epoch: u64,
    expires_at: u64,
}

#[derive(Default)]
pub struct ReadAdmission {
    session_open: bool,
    session_epoch: u64,
    projection_epoch: u64,
    viewer_epochs: HashMap<String, u64>,
    boundary_epochs: HashMap<String, u64>,
}

impl ReadAdmission {
    pub fn establish_session(&mut self) {
        self.session_open = true;
        self.advance_session();
    }

    pub fn close_session(&mut self) {
        self.session_open = false;
        self.advance_session();
    }

    pub fn invalidate_viewer(&mut self, viewer: &str) {
        if !increment(&mut self.viewer_epochs, viewer) {
            self.session_open = false;
        }
    }

    pub fn invalidate_boundary(&mut self, boundary: &str) {
        if !increment(&mut self.boundary_epochs, boundary) {
            self.session_open = false;
        }
    }

    pub fn replace_projection(&mut self) {
        if self.projection_epoch.checked_add(1).is_none() {
            self.session_open = false;
        } else {
            self.projection_epoch += 1;
        }
    }

    pub fn begin(
        &self,
        viewer: &str,
        boundary: &str,
        expires_at: u64,
        now: u64,
    ) -> Option<ReadToken> {
        if !self.session_open || now >= expires_at {
            return None;
        }
        Some(ReadToken {
            session_epoch: self.session_epoch,
            viewer: viewer.to_owned(),
            viewer_epoch: epoch(&self.viewer_epochs, viewer),
            boundary: boundary.to_owned(),
            boundary_epoch: epoch(&self.boundary_epochs, boundary),
            projection_epoch: self.projection_epoch,
            expires_at,
        })
    }

    pub fn assert_current(&self, token: &ReadToken, now: u64) -> bool {
        self.session_open
            && now < token.expires_at
            && token.session_epoch == self.session_epoch
            && token.viewer_epoch == epoch(&self.viewer_epochs, &token.viewer)
            && token.boundary_epoch == epoch(&self.boundary_epochs, &token.boundary)
            && token.projection_epoch == self.projection_epoch
    }
}

impl ReadAdmission {
    fn advance_session(&mut self) {
        if let Some(next) = self.session_epoch.checked_add(1) {
            self.session_epoch = next;
        } else {
            self.session_open = false;
        }
    }
}

fn epoch(epochs: &HashMap<String, u64>, scope: &str) -> u64 {
    epochs.get(scope).copied().unwrap_or_default()
}

fn increment(epochs: &mut HashMap<String, u64>, scope: &str) -> bool {
    let epoch = epochs.entry(scope.to_owned()).or_default();
    if let Some(next) = epoch.checked_add(1) {
        *epoch = next;
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::ReadAdmission;

    #[test]
    fn invalidation_rejects_a_captured_token_even_after_reopening() {
        let mut admission = ReadAdmission::default();
        admission.establish_session();
        let token = admission.begin("did:plc:spike", "bebop", 100, 1).unwrap();
        admission.invalidate_viewer("did:plc:spike");
        admission.establish_session();

        assert!(!admission.assert_current(&token, 2));
    }

    #[test]
    fn isolates_unrelated_viewers_and_boundaries() {
        let mut admission = ReadAdmission::default();
        admission.establish_session();
        let token = admission.begin("did:plc:faye", "bebop", 100, 1).unwrap();
        admission.invalidate_viewer("did:plc:spike");
        admission.invalidate_boundary("red-tail");

        assert!(admission.assert_current(&token, 2));
    }

    #[test]
    fn rejects_tokens_after_expiry_or_projection_replacement() {
        let mut admission = ReadAdmission::default();
        admission.establish_session();
        let token = admission.begin("did:plc:spike", "bebop", 10, 1).unwrap();
        assert!(!admission.assert_current(&token, 10));

        let token = admission.begin("did:plc:spike", "bebop", 20, 11).unwrap();
        admission.replace_projection();
        assert!(!admission.assert_current(&token, 12));
    }
}
