use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OWNER_FILE: &str = "owner";

pub struct WriterLock {
    path: PathBuf,
    owner: String,
}

#[derive(Debug)]
pub enum WriterLockError {
    Held,
    OwnershipLost,
    Io(std::io::Error),
}

impl std::fmt::Display for WriterLockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held => formatter
                .write_str("Feedgen writer lock is already held; operator recovery is required"),
            Self::OwnershipLost => formatter.write_str("Feedgen writer lock ownership was lost"),
            Self::Io(_) => formatter.write_str("Feedgen writer lock operation failed"),
        }
    }
}

impl std::error::Error for WriterLockError {}

impl WriterLock {
    pub fn acquire(path: impl AsRef<Path>) -> Result<Self, WriterLockError> {
        let path = path.as_ref().to_path_buf();
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(WriterLockError::Held);
            }
            Err(error) => return Err(WriterLockError::Io(error)),
        }
        if let Err(error) = restrict_directory(&path) {
            let _ = fs::remove_dir(&path);
            return Err(WriterLockError::Io(error));
        }
        let owner = owner_token();
        let owner_path = path.join(OWNER_FILE);
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&owner_path)
            .and_then(|mut file| {
                restrict_file(&owner_path)?;
                file.write_all(owner.as_bytes())
            });
        if let Err(error) = written {
            let _ = fs::remove_file(&owner_path);
            let _ = fs::remove_dir(&path);
            return Err(WriterLockError::Io(error));
        }
        Ok(Self { path, owner })
    }

    pub fn release(self) -> Result<(), WriterLockError> {
        let owner_path = self.path.join(OWNER_FILE);
        let current = fs::read_to_string(&owner_path).map_err(WriterLockError::Io)?;
        if current != self.owner {
            return Err(WriterLockError::OwnershipLost);
        }
        fs::remove_file(owner_path).map_err(WriterLockError::Io)?;
        fs::remove_dir(self.path).map_err(WriterLockError::Io)
    }
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_: &Path) -> std::io::Result<()> {
    Ok(())
}

fn owner_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{WriterLock, WriterLockError};

    fn path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "feedgen-ng-writer-lock-{}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn permits_one_writer_until_it_releases_its_lock() {
        let path = path("release");
        let _ = fs::remove_dir_all(&path);
        let first = WriterLock::acquire(&path).unwrap();
        assert!(matches!(
            WriterLock::acquire(&path),
            Err(WriterLockError::Held)
        ));
        first.release().unwrap();
        WriterLock::acquire(&path).unwrap().release().unwrap();
    }

    #[test]
    fn rejects_a_crash_sticky_lock_without_automatic_takeover() {
        let path = path("crash");
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        assert!(matches!(
            WriterLock::acquire(&path),
            Err(WriterLockError::Held)
        ));
        fs::remove_dir(path).unwrap();
    }
}
