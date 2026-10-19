//! A bounded public collaboration facade borrows the native TypeScript transport owned by Nanobug.
//!
//! Project discovery and analysis remain in the single TypeScript engine. This guest never keeps
//! document text, starts a second compiler, borrows a private path, or interprets a Vue method.
use plugin_protocol::{
    api::{self, ErrorCode, Failure},
    bindings::{Guest, export},
    language, language_control, service,
};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap};
mod contributions;
mod project_root;

/// Pending requests retain their original invocation handles; no reply can cross callers or epochs.
struct Pending {
    reply: api::ResourceHandle,
    task: contributions::Task,
}

#[derive(Default)]
struct State {
    pending: BTreeMap<u64, Pending>,
}

thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
struct TypeScriptPlugin;

impl Guest for TypeScriptPlugin {
    /// Dispatch only public SDK messages; lifecycle retirement is ultimately enforced by the host.
    fn dispatch(payload: String) -> Result<String, String> {
        api::guest::dispatch(&payload, |input| {
            STATE.with(|cell| {
                let mut state = cell.borrow_mut();
                match input {
                    api::Input::Prepare { .. } => state.pending.clear(),
                    api::Input::Snapshot => {
                        // The host owns durable settings. Invocation handles and compiler contexts
                        // are process-scoped resources and must never enter a saved snapshot.
                        return Ok(api::Output {
                            snapshot: Some(plugin_protocol::Snapshot {
                                schema: 1,
                                data: "{}".into(),
                            }),
                            ..Default::default()
                        });
                    }
                    api::Input::Event {
                        event: api::Notification::LanguageService(context),
                        ..
                    } => return language_plan(context),
                    api::Input::Event {
                        event: api::Notification::Service(service::Notification::Invoke(call)),
                        ..
                    } => {
                        if let Err(error) = state.invoke(call) {
                            return Ok(api::Output {
                                service_reply: Some(Err(error)),
                                ..Default::default()
                            });
                        }
                    }
                    api::Input::Event {
                        event:
                            api::Notification::Service(service::Notification::InvocationCancelled {
                                request,
                                ..
                            }),
                        ..
                    } => {
                        if let Some(pending) = state.pending.remove(&request.resource) {
                            let _ = pending.task.cancel(api::CancelMode::StopWaiting);
                        }
                    }
                    api::Input::Event { event, .. } => state.complete(&event),
                    _ => {}
                }
                Ok(api::Output::default())
            })
        })
    }
}

/// Fixed approved tools run per discovered root; tsserver owns the actual project graph within it.
/// Explicit SDK paths are sent as data to the engine policy and never cause a silent default fallback.
fn language_plan(context: language::Context) -> Result<api::Output, Failure> {
    let root = project_root::discover(context.document.as_ref())?;
    let mut options = serde_json::Map::new();
    options.insert("workspace".into(), Value::String(context.workspace.clone()));
    if let Some(value) = context.settings.get("typescript.sdk")
        && matches!(
            value.source,
            plugin_protocol::settings::Source::User | plugin_protocol::settings::Source::Project
        )
        && value.value.as_str().is_some_and(|value| !value.is_empty())
    {
        options.insert("typescript".into(), value.value.clone());
    }
    Ok(api::Output {
        language_service: Some(language::Proposal {
            context: Some(language::ProjectContext {
                key: format!("typescript:{root}"),
                generation: context
                    .document
                    .as_ref()
                    .map_or(1, |value| value.generation.max(1)),
            }),
            project_root: (!root.is_empty()).then_some(root),
            initialization_options: Some(Value::Object(options)),
            ..Default::default()
        }),
        ..Default::default()
    })
}

impl State {
    /// Public callers supply a bounded JSON value envelope; source identity is always a typed context.
    fn invoke(&mut self, call: service::Invocation) -> Result<(), Failure> {
        if self.pending.len() >= 32 {
            return Err(Failure::new(
                ErrorCode::LimitExceeded,
                "Too many TypeScript calls",
            ));
        }
        let reply = call.reply.ok_or_else(|| {
            Failure::new(
                ErrorCode::CapabilityUnavailable,
                "Deferred plugin.services 1.1 is required",
            )
        })?;
        let mut document: language::DocumentContext =
            serde_json::from_value(call.arguments["document"].clone())
                .map_err(|_| Failure::new(ErrorCode::InvalidRequest, "Invalid document context"))?;
        if !document.valid() {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                "Invalid document context",
            ));
        }
        let method = match (call.contract.as_str(), call.method.as_str()) {
            ("typescript.project", "resolve") => "typescript/project/resolve",
            ("typescript.project", "describe") => "typescript/project/describe",
            ("typescript.project", "release") => "typescript/project/release",
            ("typescript.analysis", "request") => "typescript/analysis/request",
            ("typescript.adapter", "attach") => "typescript/adapter/attach",
            _ => {
                return Err(Failure::new(
                    ErrorCode::UnsupportedOperation,
                    "Unknown TypeScript contract method",
                ));
            }
        };
        let encoded = call.arguments["payload"]
            .as_str()
            .ok_or_else(|| Failure::new(ErrorCode::InvalidRequest, "Missing TypeScript payload"))?;
        if encoded.len() > 48 * 1024 {
            return Err(Failure::new(
                ErrorCode::LimitExceeded,
                "TypeScript payload exceeds quota",
            ));
        }
        let arguments: serde_json::Map<String, Value> =
            serde_json::from_str(encoded).map_err(|_| {
                Failure::new(
                    ErrorCode::InvalidRequest,
                    "TypeScript payload must be an object",
                )
            })?;
        // The native host seals the broker's true caller in reserved transport metadata.
        // No caller-controlled payload may impersonate that source or supply an import path.
        if ["consumer", "_nanobug", "path"]
            .iter()
            .any(|key| arguments.contains_key(*key))
        {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                "Reserved TypeScript control metadata",
            ));
        }
        let imports = if method == "typescript/adapter/attach" {
            let export = arguments
                .get("export")
                .and_then(Value::as_str)
                .ok_or_else(|| Failure::new(ErrorCode::InvalidRequest, "Missing adapter export"))?;
            vec![language_control::Import {
                export: export.into(),
                reference: None,
            }]
        } else {
            Vec::new()
        };
        // The caller's source provider and this TS provider have independent host watermarks.
        // Preserve the original generation only for publishing the caller's delegated binding.
        let publish_binding = (method == "typescript/adapter/attach").then(|| document.clone());
        document.generation = 0;
        let request = language_control::Request {
            provider: "analysis".into(),
            arguments: json!({ "path": document.path, "payload": encoded }),
            context_snapshot: method == "typescript/analysis/request",
            service_sets: Vec::new(),
            publish_binding,
            document,
            method: method.into(),
            imports,
        };
        let task = contributions::Task::start(request)?;
        self.pending.insert(reply.resource, Pending { reply, task });
        Ok(())
    }

    /// Completing a native request releases exactly its deferred service invocation, including errors.
    fn complete(&mut self, event: &api::Notification) {
        let mut ready = Vec::new();
        for (id, pending) in &mut self.pending {
            match pending.task.update(event) {
                Some(api::RequestUpdate::Completed { result }) => ready.push((
                    *id,
                    result.and_then(|value| {
                        let (mut value, binding) = match value {
                            api::EditorValue::Language(value) => (value, None),
                            api::EditorValue::LanguageBinding { value, binding } => {
                                (value, Some(binding))
                            }
                            _ => {
                                return Err(Failure::new(
                                    ErrorCode::InvalidState,
                                    "Unexpected TypeScript result",
                                ));
                            }
                        };
                        let payload =
                            value
                                .get("payload")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    Failure::new(
                                        ErrorCode::InvalidState,
                                        "Invalid TypeScript result",
                                    )
                                })?;
                        if payload.len() > 48 * 1024 {
                            return Err(Failure::new(
                                ErrorCode::LimitExceeded,
                                "TypeScript result exceeds quota",
                            ));
                        }
                        if let Some(binding) = binding {
                            value["binding"] = Value::String(binding);
                        }
                        Ok(value)
                    }),
                )),
                Some(api::RequestUpdate::Cancelled { reason, .. }) => ready.push((
                    *id,
                    Err(Failure::new(reason, "TypeScript request cancelled")),
                )),
                _ => {}
            }
        }
        for (id, result) in ready {
            if let Some(pending) = self.pending.remove(&id) {
                let _ = service::guest::reply(&pending.reply, result);
            }
        }
    }
}

export!(TypeScriptPlugin);
