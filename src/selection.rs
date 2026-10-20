//! Native project choice retains metadata/tasks only; the compiler owns graph membership.
use plugin_protocol::{
    api::{self, ErrorCode, Failure},
    interaction, language, language_context, language_control, service,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Deferred host preparation and explicit native reselect share one bounded choice implementation.
#[derive(Default)]
pub(crate) struct Selection {
    pending: BTreeMap<u64, Pending>,
}
struct Pending {
    reply: Option<api::ResourceHandle>,
    document: language::DocumentContext,
    source: Option<api::DocumentVersion>,
    hint: Option<String>,
    force: bool,
    save: bool,
    references: Vec<language_context::Reference>,
    preference: api::PreferenceValue,
    task: api::guest::EditorTask,
    phase: Phase,
}
enum Phase {
    Active,
    Candidates,
    Inferred,
    Pick,
    Bind(String),
    Refresh(String),
}

impl Selection {
    /// The host's interactive profile retains the original preparation's cancellation and permissions.
    pub(crate) fn prepare(&mut self, call: service::Invocation) -> Result<(), Failure> {
        self.capacity()?;
        let reply = call
            .reply
            .ok_or_else(|| invalid("Language preparation requires a deferred reply"))?;
        let document: language::DocumentContext =
            serde_json::from_value(call.arguments["document"].clone())
                .map_err(|_| invalid("Invalid language preparation source"))?;
        if !document.valid() {
            return Err(invalid("Invalid language preparation source"));
        }
        let task = candidates(&document)?;
        self.pending.insert(
            reply.resource,
            Pending {
                reply: Some(reply),
                document,
                source: None,
                hint: call.arguments["source_context"].as_str().map(str::to_owned),
                force: false,
                save: false,
                references: Vec::new(),
                preference: Default::default(),
                task,
                phase: Phase::Candidates,
            },
        );
        Ok(())
    }

    /// An editor command captures the actual current source version before opening a modal picker.
    pub(crate) fn reselect(&mut self) -> Result<(), Failure> {
        self.capacity()?;
        let handle = api::guest::editor(api::EditorOperation::ReadSelection, 5_000)?;
        let key = handle.resource;
        let task = api::guest::EditorTask::from_accepted(handle);
        self.pending.insert(
            key,
            Pending {
                reply: None,
                document: language::DocumentContext {
                    path: String::new(),
                    generation: 0,
                },
                source: None,
                hint: None,
                force: true,
                save: false,
                references: Vec::new(),
                preference: Default::default(),
                task,
                phase: Phase::Active,
            },
        );
        Ok(())
    }

    fn capacity(&self) -> Result<(), Failure> {
        if self.pending.len() >= 32 {
            Err(Failure::new(
                ErrorCode::LimitExceeded,
                "Too many pending project choices",
            ))
        } else {
            Ok(())
        }
    }

    pub(crate) fn cancel(&mut self, request: u64) {
        if let Some(pending) = self.pending.remove(&request) {
            let _ = pending.task.cancel(api::CancelMode::StopWaiting);
        }
    }
    pub(crate) fn clear(&mut self) {
        for (_, pending) in std::mem::take(&mut self.pending) {
            let _ = pending.task.cancel(api::CancelMode::StopWaiting);
        }
    }

    /// A late event cannot publish a partial binding after cancellation, retirement or a replaced task.
    pub(crate) fn update(
        &mut self,
        event: &api::Notification,
        catalog: &mut crate::catalog::Catalog,
    ) {
        let mut complete = Vec::new();
        for (id, pending) in &mut self.pending {
            let Some(update) = pending.task.update(event) else {
                continue;
            };
            let result = match update {
                api::RequestUpdate::Completed { result } => {
                    result.and_then(|value| pending.advance(value, catalog))
                }
                api::RequestUpdate::Cancelled { reason, .. } => {
                    Err(Failure::new(reason, "Project selection cancelled"))
                }
                _ => continue,
            };
            match result {
                Ok(None) => {}
                result => complete.push((*id, result)),
            }
        }
        for (id, result) in complete {
            let pending = self.pending.remove(&id).unwrap();
            if let Some(reply) = pending.reply {
                let _ =
                    service::guest::reply(&reply, result.map(|value| value.unwrap_or(Value::Null)));
            } else if let Err(error) = result
                && error.code != ErrorCode::Cancelled
            {
                let _ = interaction::start(
                    interaction::Operation::Notify {
                        title: "TypeScript project / TypeScript 项目".into(),
                        message: error.message,
                        severity: interaction::Severity::Error,
                    },
                    30_000,
                );
            }
        }
    }
}

impl Pending {
    /// All transitions consume a successful typed host result; no source text is retained here.
    fn advance(
        &mut self,
        value: api::EditorValue,
        catalog: &mut crate::catalog::Catalog,
    ) -> Result<Option<Value>, Failure> {
        match &self.phase {
            Phase::Active => {
                let api::EditorValue::Selection { document, .. } = value else {
                    return Err(invalid("Expected current native source"));
                };
                self.document.path = document.path.clone();
                self.source = Some(document);
                self.task = candidates(&self.document)?;
                self.phase = Phase::Candidates;
            }
            Phase::Candidates => {
                let values = payload(value)?;
                let candidates = values
                    .as_array()
                    .ok_or_else(|| invalid("Invalid project candidate list"))?;
                if candidates.is_empty() {
                    self.task = native(
                        &self.document,
                        "typescript/project/resolve",
                        json!({}),
                        None,
                    )?;
                    self.phase = Phase::Inferred;
                } else {
                    let descriptors = candidates.iter().map(|candidate| Ok(language_context::Descriptor {
                        provider: "engine".into(), key: candidate["key"].as_str().ok_or_else(|| invalid("Missing project identity"))?.into(),
                        generation: candidate["generation"].as_u64().ok_or_else(|| invalid("Missing project generation"))?,
                        project_root: candidate["root"].as_str().ok_or_else(|| invalid("Missing project root"))?.into(),
                        data: json!({"config":candidate["config"],"stamp":candidate["stamp"]}),
                    })).collect::<Result<Vec<_>, Failure>>()?;
                    self.choose(descriptors, catalog)?;
                }
            }
            Phase::Inferred => {
                let value = payload(value)?;
                let mut descriptor: language_context::Descriptor = serde_json::from_value(json!({
                    "provider":"engine", "key":value["registration"]["key"],
                    "generation":value["registration"]["generation"],
                    "project_root":value["registration"]["project_root"], "data":value["registration"]["data"],
                })).map_err(|_| invalid("Invalid inferred project registration"))?;
                descriptor.provider = "engine".into();
                self.choose(vec![descriptor], catalog)?;
            }
            Phase::Pick => {
                let api::EditorValue::Interaction(interaction::Value::Picked(key)) = value else {
                    return Err(invalid("Expected a native project choice"));
                };
                let reference = self
                    .references
                    .iter()
                    .find(|reference| reference.descriptor.key == key)
                    .cloned()
                    .ok_or_else(|| invalid("Project choice is no longer available"))?;
                self.save = true;
                self.bind(reference)?;
            }
            Phase::Bind(key) => {
                let key = key.clone();
                if if self.force {
                    !matches!(value, api::EditorValue::Language(_))
                } else {
                    !matches!(value, api::EditorValue::LanguageBinding { .. })
                } {
                    return Err(invalid("Expected an owned native binding result"));
                }
                if self.save && !self.force {
                    // Never silently overwrite another native window's newer display preference.
                    api::guest::write_preference(
                        preference_key(&self.document.path),
                        self.preference.revision,
                        json!({"schema":1,"source":self.document.path,"project":key}),
                    )?;
                }
                if self.force {
                    let source = self
                        .source
                        .clone()
                        .ok_or_else(|| invalid("Missing original native source"))?;
                    let reference = self
                        .references
                        .iter()
                        .find(|reference| reference.descriptor.key == key)
                        .unwrap();
                    let accepted = api::guest::request(api::Operation::LanguageContexts {
                        operation: language_context::Operation::Refresh {
                            context: reference.token.clone(),
                            provider: "analysis".into(),
                            document: source,
                        },
                    })?;
                    let api::Value::Accepted(handle) = accepted else {
                        return Err(invalid("Expected native context refresh"));
                    };
                    self.task = api::guest::EditorTask::from_accepted(handle);
                    self.phase = Phase::Refresh(key);
                } else {
                    let api::EditorValue::LanguageBinding { binding, .. } = value else {
                        return Err(invalid("Expected an owned native binding"));
                    };
                    return Ok(Some(json!({"binding":binding})));
                }
            }
            Phase::Refresh(key) => {
                if !matches!(value, api::EditorValue::Unit) {
                    return Err(invalid("Expected native context refresh acknowledgement"));
                }
                // The native host has now rechecked the original source. Stale/cancelled choices
                // never update a durable preference, and another window's CAS still wins.
                if self.save {
                    api::guest::write_preference(
                        preference_key(&self.document.path),
                        self.preference.revision,
                        json!({"schema":1,"source":self.document.path,"project":key}),
                    )?;
                }
                return Ok(Some(Value::Null));
            }
        }
        Ok(None)
    }

    /// Origin affects only this navigation. Only an explicit picked choice is persisted with CAS.
    fn choose(
        &mut self,
        descriptors: Vec<language_context::Descriptor>,
        catalog: &mut crate::catalog::Catalog,
    ) -> Result<(), Failure> {
        self.references = catalog.register(descriptors)?;
        self.preference =
            api::guest::read_preference(preference_key(&self.document.path), false)?.value;
        let hint = self
            .hint
            .as_ref()
            .and_then(|hint| language_context::describe(hint).ok());
        let choice = if self.force {
            None
        } else {
            hint.and_then(|hint| {
                self.references
                    .iter()
                    .find(|reference| reference.descriptor == hint.descriptor)
                    .cloned()
            })
            .or_else(|| {
                self.preference
                    .data
                    .as_ref()
                    .filter(|value| {
                        value["schema"] == 1
                            && value["source"].as_str() == Some(self.document.path.as_str())
                    })
                    .and_then(|value| value["project"].as_str())
                    .and_then(|key| {
                        self.references
                            .iter()
                            .find(|reference| reference.descriptor.key == key)
                            .cloned()
                    })
            })
            .or_else(|| (self.references.len() == 1).then(|| self.references[0].clone()))
        };
        if let Some(reference) = choice {
            return self.bind(reference);
        }
        self.task = api::guest::EditorTask::start(
            api::EditorOperation::Interaction {
                operation: interaction::Operation::QuickPick {
                    title: "Select analysis project / 选择分析项目".into(),
                    items: self
                        .references
                        .iter()
                        .map(|reference| interaction::PickItem {
                            id: reference.descriptor.key.clone(),
                            label: if reference.descriptor.project_root.is_empty() {
                                ".".into()
                            } else {
                                display_path(&reference.descriptor.project_root, 256)
                            },
                            description: reference.descriptor.data["config"]
                                .as_str()
                                .map(|path| display_path(path, 1024)),
                        })
                        .collect(),
                },
            },
            90_000,
        )?;
        self.phase = Phase::Pick;
        Ok(())
    }

    fn bind(&mut self, reference: language_context::Reference) -> Result<(), Failure> {
        language_context::describe(&reference.token)?;
        let mut request = request(&self.document, "typescript/project/bind", json!({}));
        if !self.force {
            request.publish_binding = Some(self.document.clone());
        }
        self.task = language_context::control(reference.token, request, 30_000)?;
        self.phase = Phase::Bind(reference.descriptor.key);
        Ok(())
    }
}

/// Persisted names hash `typescript.project.v1`, NUL, then the exact portable path as UTF-8.
/// Do not case-fold or normalize Unicode: the native source identity, not a guest path guess, wins.
/// Full lowercase hex fits the public 64-byte key limit; the version stays inside the digest input.
/// The workspace-local record retains its source string to verify identity before using a choice.
fn preference_key(path: &str) -> api::PreferenceKey {
    let mut digest = Sha256::new();
    digest.update(b"typescript.project.v1\0");
    digest.update(path.as_bytes());
    api::PreferenceKey {
        file_type: String::new(),
        name: format!("{:x}", digest.finalize()),
    }
}
/// Long Unicode paths retain their distinguishing suffix within the native picker's byte budgets.
fn display_path(path: &str, limit: usize) -> String {
    if path.len() <= limit {
        return path.into();
    }
    let mut start = path.len() - limit + '…'.len_utf8();
    while !path.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &path[start..])
}
fn candidates(document: &language::DocumentContext) -> Result<api::guest::EditorTask, Failure> {
    native(document, "typescript/project/candidates", json!({}), None)
}
fn native(
    document: &language::DocumentContext,
    method: &str,
    payload: Value,
    context: Option<String>,
) -> Result<api::guest::EditorTask, Failure> {
    let request = request(document, method, payload);
    match context {
        Some(context) => language_context::control(context, request, 30_000),
        None => {
            api::guest::EditorTask::start(api::EditorOperation::LanguageRequest { request }, 30_000)
        }
    }
}
fn request(
    document: &language::DocumentContext,
    method: &str,
    payload: Value,
) -> language_control::Request {
    language_control::Request {
        provider: "engine".into(),
        document: language::DocumentContext {
            path: document.path.clone(),
            generation: 0,
        },
        method: method.into(),
        arguments: json!({"path":document.path,"payload":payload.to_string()}),
        context_snapshot: false,
        imports: Vec::new(),
        service_sets: Vec::new(),
        publish_binding: None,
    }
}
fn payload(value: api::EditorValue) -> Result<Value, Failure> {
    let api::EditorValue::Language(value) = value else {
        return Err(invalid("Expected a native TypeScript response"));
    };
    serde_json::from_str(
        value["payload"]
            .as_str()
            .ok_or_else(|| invalid("Missing TypeScript response payload"))?,
    )
    .map_err(|_| invalid("Invalid TypeScript response payload"))
}
fn invalid(message: &str) -> Failure {
    Failure::new(ErrorCode::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    //! Regression coverage for stable preference names without reinterpreting source paths.

    use super::preference_key;

    /// Persisted names are a versioned serialization contract, independent of compiler hashers.
    #[test]
    fn source_preference_keys_use_stable_exact_utf8_without_path_reinterpretation() {
        for source in ["shared.ts", "子项目/共享.ts", "e\u{301}.ts", "é.ts"] {
            preference_key(source)
                .validate()
                .expect("persisted keys must fit the current public preference contract");
        }
        assert_eq!(
            preference_key("shared.ts").name,
            "73b150774612b970e524746544636b2c0e14fbdc748154c6cb3dbb7648ec1128"
        );
        assert_eq!(
            preference_key("子项目/共享.ts").name,
            "7ce0b91d61ad689aaf74c16451906788ccc7f90a64349d9ce23784c6d6bd8165"
        );
        assert_eq!(preference_key("shared.ts").file_type, "");
        assert_ne!(
            preference_key("A/shared.ts").name,
            preference_key("a/shared.ts").name
        );
        assert_ne!(
            preference_key("e\u{301}.ts").name,
            preference_key("é.ts").name
        );
    }
}
