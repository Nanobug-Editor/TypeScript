//! Asynchronous composition discovery owns every peer reference in the final module-loading guest.
use plugin_protocol::{
    api::{self, ErrorCode, Failure},
    language_control, service,
};
use serde_json::{Value, json};

const CONTRACT: &str = "language.contribution";

/// One facade request either forwards native work directly or prepares an explicit contribution set.
pub(crate) enum Task {
    Native(api::guest::EditorTask),
    Composition(Preparation),
}
impl Task {
    /// Callers without an extension ABI retain the existing single-adapter path and dependencies.
    pub(crate) fn start(request: language_control::Request) -> Result<Self, Failure> {
        let input: Value =
            serde_json::from_str(request.arguments["payload"].as_str().unwrap_or(""))
                .map_err(|_| invalid("Invalid composition payload"))?;
        if request.method != "typescript/adapter/attach" || input.get("extensionAbi").is_none() {
            return api::guest::EditorTask::start(
                api::EditorOperation::LanguageRequest { request },
                30_000,
            )
            .map(Self::Native);
        }
        let abi = input["extensionAbi"]
            .as_str()
            .filter(|abi| !abi.is_empty() && abi.len() <= 128)
            .ok_or_else(|| invalid("Invalid requested extension ABI"))?
            .to_owned();
        let mut describe = request.clone();
        describe.method = "typescript/project/describe".into();
        describe.imports.clear();
        describe.publish_binding = None;
        describe.arguments["payload"] = json!(json!({"context":input["context"]}).to_string());
        let task = api::guest::EditorTask::start(
            api::EditorOperation::LanguageRequest { request: describe },
            30_000,
        )?;
        Ok(Self::Composition(Preparation {
            request,
            abi,
            project: Value::Null,
            set: None,
            cursor: 0,
            contributions: Vec::new(),
            imports: Vec::new(),
            phase: Phase::Describe(task),
        }))
    }
    /// Native and peer updates keep their original service invocation source and cancellation chain.
    pub(crate) fn update(&mut self, event: &api::Notification) -> Option<api::RequestUpdate> {
        match self {
            Self::Native(task) => task.update(event),
            Self::Composition(task) => task.update(event),
        }
    }
    pub(crate) fn cancel(&self, mode: api::CancelMode) -> Result<api::CancellationEffect, Failure> {
        match self {
            Self::Native(task) => task.cancel(mode),
            Self::Composition(task) => task.cancel(mode),
        }
    }
}

enum Phase {
    Describe(api::guest::EditorTask),
    Peer(service::guest::Task),
    Attach(api::guest::EditorTask),
    Done,
}

/// Only metadata/settings and service references are retained; source text stays in the TS worker.
pub(crate) struct Preparation {
    request: language_control::Request,
    abi: String,
    project: Value,
    set: Option<service::ServiceSet>,
    cursor: usize,
    contributions: Vec<Value>,
    imports: Vec<language_control::Import>,
    phase: Phase,
}
impl Preparation {
    fn cancel(&self, mode: api::CancelMode) -> Result<api::CancellationEffect, Failure> {
        match &self.phase {
            Phase::Describe(task) | Phase::Attach(task) => task.cancel(mode),
            Phase::Peer(task) => task.cancel(mode),
            Phase::Done => Ok(api::CancellationEffect::NotExecuted),
        }
    }
    fn update(&mut self, event: &api::Notification) -> Option<api::RequestUpdate> {
        let result = match &mut self.phase {
            Phase::Describe(task) | Phase::Attach(task) => match task.update(event)? {
                api::RequestUpdate::Completed { result } => result,
                api::RequestUpdate::Cancelled { reason, .. } => {
                    Err(Failure::new(reason, "Composition preparation cancelled"))
                }
                other => return Some(other),
            },
            Phase::Peer(task) => {
                let api::Notification::Service(event) = event else {
                    return None;
                };
                match task.update(event)? {
                    api::RequestUpdate::Completed { result } => {
                        result.map(api::EditorValue::Language)
                    }
                    api::RequestUpdate::Cancelled { reason, .. } => {
                        Err(Failure::new(reason, "Contribution preparation cancelled"))
                    }
                    _ => return None,
                }
            }
            Phase::Done => return None,
        };
        match result.and_then(|value| self.advance(value)) {
            Ok(Some(value)) => {
                self.phase = Phase::Done;
                Some(api::RequestUpdate::Completed { result: Ok(value) })
            }
            Ok(None) => None,
            Err(error) => {
                self.phase = Phase::Done;
                Some(api::RequestUpdate::Completed { result: Err(error) })
            }
        }
    }
    fn advance(&mut self, value: api::EditorValue) -> Result<Option<api::EditorValue>, Failure> {
        if matches!(self.phase, Phase::Attach(_)) {
            service::guest::validate_set(CONTRACT, self.set.as_ref().unwrap().revision)?;
            return Ok(Some(value));
        }
        let api::EditorValue::Language(value) = value else {
            return Err(invalid("Invalid composition stage result"));
        };
        let text = value["payload"]
            .as_str()
            .filter(|text| text.len() <= 48 * 1024)
            .ok_or_else(|| invalid("Invalid contribution result envelope"))?;
        let result: Value =
            serde_json::from_str(text).map_err(|_| invalid("Invalid contribution result JSON"))?;
        if matches!(self.phase, Phase::Describe(_)) {
            self.project = result;
            let original: Value =
                serde_json::from_str(self.request.arguments["payload"].as_str().unwrap()).unwrap();
            if original["context"] != self.project["context"]
                || original["generation"] != self.project["generation"]
            {
                return Err(Failure::new(
                    ErrorCode::StaleRevision,
                    "Project changed before contribution preparation",
                ));
            }
            self.set = Some(service::guest::open_set(CONTRACT)?);
        } else {
            let values = result["contributions"]
                .as_array()
                .filter(|values| values.len() <= 15)
                .ok_or_else(|| invalid("Invalid contribution collection"))?;
            for value in values {
                if value["abi"].as_str() != Some(self.abi.as_str()) {
                    return Err(invalid(
                        "Contribution ABI does not match the requested adapter",
                    ));
                }
                let export = value["export"]
                    .as_str()
                    .filter(|value| language_control::valid_export_id(value))
                    .ok_or_else(|| invalid("Invalid contribution export"))?;
                if self.imports.len() >= 15 {
                    return Err(Failure::new(
                        ErrorCode::LimitExceeded,
                        "Too many contributed modules",
                    ));
                }
                self.imports.push(language_control::Import {
                    export: export.into(),
                    reference: Some(
                        self.set.as_ref().unwrap().members[self.cursor - 1]
                            .reference
                            .clone(),
                    ),
                });
                self.contributions.push(value.clone());
            }
        }
        self.next()?;
        Ok(None)
    }
    fn next(&mut self) -> Result<(), Failure> {
        let set = self.set.as_ref().unwrap();
        service::guest::validate_set(CONTRACT, set.revision)?;
        if let Some(member) = set.members.get(self.cursor) {
            let task = service::guest::Task::start(
                &member.reference,
                "prepare",
                json!({"document":self.request.document,"payload":json!({"extensionAbi":self.abi,"project":self.project}).to_string()}),
                30_000,
            )?;
            self.cursor += 1;
            self.phase = Phase::Peer(task);
        } else {
            let mut request = self.request.clone();
            let mut input: Value =
                serde_json::from_str(request.arguments["payload"].as_str().unwrap()).unwrap();
            input["contributions"] = Value::Array(self.contributions.clone());
            request.arguments["payload"] = json!(input.to_string());
            request.imports.extend(self.imports.clone());
            request
                .service_sets
                .push(language_control::ServiceSetDependency {
                    contract: CONTRACT.into(),
                    revision: set.revision,
                });
            self.phase = Phase::Attach(api::guest::EditorTask::start(
                api::EditorOperation::LanguageRequest { request },
                30_000,
            )?);
        }
        Ok(())
    }
}
impl Drop for Preparation {
    /// Even cancellation/error releases every discovered peer, including those not called yet.
    fn drop(&mut self) {
        let _ = self.cancel(api::CancelMode::StopWaiting);
        if let Some(set) = self.set.take() {
            for member in set.members {
                let _ = api::guest::close_resource(member.reference);
            }
        }
    }
}
fn invalid(message: &str) -> Failure {
    Failure::new(ErrorCode::InvalidRequest, message)
}
