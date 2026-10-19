//! A separately installed, unknown ecosystem provider contributes code rather than consuming analysis.
use plugin_protocol::{
    api,
    bindings::{Guest, export},
    service,
};
use serde_json::json;
struct Ecosystem;
impl Guest for Ecosystem {
    /// Preparation consumes project metadata only and returns immutable export selectors, never paths.
    fn dispatch(payload: String) -> Result<String, String> {
        api::guest::dispatch(&payload, |input| {
            let api::Input::Event {
                event: api::Notification::Service(service::Notification::Invoke(call)),
                ..
            } = input
            else {
                return Ok(Default::default());
            };
            let request: serde_json::Value = serde_json::from_str(
                call.arguments["payload"].as_str().unwrap_or(""),
            )
            .map_err(|_| {
                api::Failure::new(
                    api::ErrorCode::InvalidRequest,
                    "Expected ecosystem metadata",
                )
            })?;
            let contributions = if request["extensionAbi"] == "vue.language-plugin/1" {
                vec![
                    json!({"id":"unknown-source-check","role":"types","slot":"script-types","mode":"compose",
                    "abi":"vue.language-plugin/1","export":"check","config":{},"before":[],"after":[]}),
                ]
            } else {
                Vec::new()
            };
            Ok(api::Output {
                service_reply: Some(Ok(
                    json!({"payload":json!({"contributions":contributions}).to_string()}),
                )),
                ..Default::default()
            })
        })
    }
}
export!(Ecosystem);
