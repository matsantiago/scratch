use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

pub static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveResult<T> {
    Saved { note: T },
    Conflict { disk: Option<String> },
}

fn read_current(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn write_note(
    source: Option<(&Path, &str)>,
    destination: &Path,
    content: &str,
) -> io::Result<SaveResult<()>> {
    let in_place = source.is_some_and(|(path, _)| path == destination);
    let destination = if in_place && destination.is_symlink() {
        fs::canonicalize(destination)?
    } else {
        destination.to_path_buf()
    };
    let directory = destination.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    staged.write_all(content.as_bytes())?;
    if let Some((path, expected)) = source {
        if let Ok(metadata) = fs::metadata(path) {
            staged.as_file().set_permissions(metadata.permissions())?;
        }
        let disk = read_current(path)?;
        if disk.as_deref() != Some(expected) {
            return Ok(SaveResult::Conflict { disk });
        }
    }
    if in_place {
        staged.persist(&destination)?;
    } else {
        staged.persist_noclobber(&destination)?;
        if let Some((path, expected)) = source {
            // A title change writes a new file. Keep the old file if another
            // writer changed it while the new name was being committed.
            let disk = read_current(path)?;
            if disk.as_deref() != Some(expected) {
                return Ok(SaveResult::Conflict { disk });
            }
            fs::remove_file(path)?;
        }
    }
    Ok(SaveResult::Saved { note: () })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_same_length_external_edit_blocks_a_stale_save() -> io::Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().join("note.md");
        fs::write(&path, "disk")?;
        let result = write_note(Some((&path, "base")), &path, "draft")?;
        assert!(matches!(result, SaveResult::Conflict { disk: Some(disk) } if disk == "disk"));
        assert_eq!(fs::read_to_string(path)?, "disk");
        Ok(())
    }

    #[test]
    fn a_successful_save_changes_the_base_for_subsequent_saves() -> io::Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().join("note.md");
        fs::write(&path, "base")?;
        assert!(matches!(
            write_note(Some((&path, "base")), &path, "first")?,
            SaveResult::Saved { .. }
        ));
        assert!(matches!(
            write_note(Some((&path, "base")), &path, "stale")?,
            SaveResult::Conflict { .. }
        ));
        assert!(matches!(
            write_note(Some((&path, "first")), &path, "second")?,
            SaveResult::Saved { .. }
        ));
        assert_eq!(fs::read_to_string(path)?, "second");
        Ok(())
    }

    #[test]
    fn a_missing_file_is_never_recreated_by_a_stale_editor() -> io::Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().join("deleted.md");
        let result = write_note(Some((&path, "base")), &path, "draft")?;
        assert!(matches!(result, SaveResult::Conflict { disk: None }));
        assert!(!path.exists());
        Ok(())
    }

    #[test]
    fn title_changes_check_both_the_original_file_and_the_destination() -> io::Result<()> {
        let folder = tempfile::tempdir()?;
        let source = folder.path().join("old.md");
        let destination = folder.path().join("new.md");
        fs::write(&source, "disk")?;
        let result = write_note(Some((&source, "base")), &destination, "draft")?;
        assert!(matches!(result, SaveResult::Conflict { .. }));
        assert!(!destination.exists());
        fs::write(&destination, "other note")?;
        let err = write_note(Some((&source, "disk")), &destination, "draft").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&destination)?, "other note");
        assert_eq!(fs::read_to_string(&source)?, "disk");
        Ok(())
    }
}
