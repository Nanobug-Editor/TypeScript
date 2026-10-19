//! Read-only project admission gives each configured root its own host-owned transport lifetime.
use plugin_protocol::{
    api::{self, ErrorCode, Failure},
    language,
};

/// Find the nearest conventional TS configuration within the original workspace authority.
/// Missing configurations produce an inferred directory context, rather than a workspace-wide worker.
pub fn discover(document: Option<&language::DocumentContext>) -> Result<String, Failure> {
    let Some(document) = document else {
        return Ok(String::new());
    };
    let mut directory = document
        .path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
        .to_owned();
    let inferred = directory.clone();
    let workspace = api::guest::open_workspace()?;
    let result = (|| {
        for _ in 0..64 {
            for name in ["tsconfig.json", "jsconfig.json"] {
                let candidate = if directory.is_empty() {
                    name.into()
                } else {
                    format!("{directory}/{name}")
                };
                match api::guest::read_file(&workspace, candidate) {
                    Ok(_) => return Ok(directory),
                    Err(error) if error.code == ErrorCode::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
            if directory.is_empty() {
                return Ok(inferred);
            }
            directory = directory
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or("")
                .into();
        }
        Err(Failure::new(
            ErrorCode::LimitExceeded,
            "Project path exceeds discovery depth",
        ))
    })();
    let _ = api::guest::close_resource(workspace);
    result
}
