//! A separately installed, unknown ecosystem provider contributes code rather than consuming analysis.
use plugin_protocol::{
    api::{self, ErrorCode, Failure},
    bindings::{Guest, export},
    service,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Every Package variant uses the same component; only its immutable declarations differ.
struct Ecosystem;
impl Guest for Ecosystem {
    /// Return declarative selectors and a stateless lifecycle snapshot through the public SDK.
    fn dispatch(payload: String) -> Result<String, String> {
        api::guest::dispatch(&payload, |input| {
            let call = match input {
                api::Input::Snapshot => {
                    // Host settings and the immutable package own configuration. No invocation,
                    // source snapshot, service reference or native handle can survive retirement.
                    return Ok(api::Output {
                        snapshot: Some(plugin_protocol::Snapshot {
                            schema: 1,
                            data: "{}".into(),
                        }),
                        ..Default::default()
                    });
                }
                api::Input::Event {
                    event: api::Notification::Service(service::Notification::Invoke(call)),
                    ..
                } => call,
                _ => return Ok(Default::default()),
            };
            Ok(api::Output {
                service_reply: Some(prepare(&call.arguments)),
                ..Default::default()
            })
        })
    }
}

/// Consume bounded project metadata and return only package-owned selectors for the requested ABI.
/// Errors are typed service replies, so malformed fixtures cannot masquerade as an empty collection.
fn prepare(arguments: &Value) -> Result<Value, Failure> {
    let payload = arguments["payload"]
        .as_str()
        .filter(|value| value.len() <= 48 * 1024)
        .ok_or_else(|| invalid("Expected bounded ecosystem metadata"))?;
    let request: Value =
        serde_json::from_str(payload).map_err(|_| invalid("Expected ecosystem metadata JSON"))?;
    let contributions = if request["extensionAbi"] == "vue.language-plugin/1" {
        declarations()?
    } else {
        Vec::new()
    };
    Ok(json!({"payload":json!({"contributions":contributions}).to_string()}))
}

/// Read only this admitted package's inert fixture data. Composition conflicts and deliberately bad
/// semantic mappings remain the real TS/Vue loader's responsibility, after normal module admission.
fn declarations() -> Result<Vec<Value>, Failure> {
    let bytes = api::guest::read_asset("contributions.json")?;
    if bytes.len() > 8192 {
        return Err(Failure::new(
            ErrorCode::LimitExceeded,
            "Fixture contributions exceed 8 KiB",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Invalid fixture contributions JSON"))?;
    let values = value
        .as_array()
        .filter(|values| values.len() <= 15)
        .ok_or_else(|| invalid("Expected at most fifteen fixture contributions"))?;
    let mut ids = BTreeSet::new();
    for value in values {
        let fields = value
            .as_object()
            .ok_or_else(|| invalid("Expected a fixture contribution record"))?;
        if fields.keys().any(|key| {
            ![
                "id", "role", "slot", "mode", "abi", "export", "config", "before", "after",
            ]
            .contains(&key.as_str())
        }) || !["id", "slot"].iter().all(|key| identifier(&value[*key]))
            || !ids.insert(value["id"].as_str().unwrap())
        {
            return Err(invalid(
                "Invalid or duplicate fixture contribution identity",
            ));
        }
        let role = value["role"]
            .as_str()
            .filter(|role| ["template", "style", "project", "types"].contains(role))
            .ok_or_else(|| invalid("Unknown fixture contribution role"))?;
        if value["abi"] != "vue.language-plugin/1"
            || !(value["export"] == role || role == "types" && value["export"] == "check")
            || !matches!(value["mode"].as_str(), Some("compose" | "exclusive"))
            || !value["config"].is_object()
            || value["config"]["role"] != role
        {
            return Err(invalid(
                "Invalid fixture role, ABI, export or configuration",
            ));
        }
        for key in ["before", "after"] {
            if !value[key]
                .as_array()
                .is_some_and(|edges| edges.len() <= 15 && edges.iter().all(identifier))
            {
                return Err(invalid("Invalid fixture contribution ordering"));
            }
        }
    }
    Ok(values.clone())
}

/// Match the composition ABI's bounded ASCII identifier without accepting a path from a caller.
fn identifier(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
    })
}

/// Fixture errors retain the protocol classification consumed by ordinary public service callers.
fn invalid(message: &str) -> Failure {
    Failure::new(ErrorCode::InvalidRequest, message)
}

export!(Ecosystem);
