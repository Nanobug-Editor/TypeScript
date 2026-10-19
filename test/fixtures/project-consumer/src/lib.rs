//! Unknown SDK consumer: five separately correlated service calls share one native project reference.
use plugin_protocol::{
    api,
    bindings::{Guest, export},
    service, ui,
};
use serde_json::{Value, json};
use std::cell::RefCell;

#[derive(Default)]
struct State {
    project: Option<api::ResourceHandle>,
    analysis: Option<api::ResourceHandle>,
    task: Option<service::guest::Task>,
    path: String,
    phase: usize,
    context: Value,
    observations: Vec<Value>,
    receipt: Option<Value>,
    revision: u64,
}
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
struct Consumer;

impl State {
    /// References are owned by this consumer throughout resolve/describe/analyze/release; no native
    /// tool is started here, and the opaque project identity is never treated as a file grant.
    fn start(&mut self, arguments: Option<Value>) -> Result<(), api::Failure> {
        self.close();
        self.path = arguments
            .as_ref()
            .and_then(|value| value["path"].as_str())
            .ok_or_else(|| {
                api::Failure::new(api::ErrorCode::InvalidRequest, "Missing document path")
            })?
            .into();
        self.phase = 0;
        self.observations.clear();
        self.receipt = None;
        self.project = Some(service::guest::open("typescript.project")?);
        self.analysis = Some(service::guest::open("typescript.analysis")?);
        self.next()
    }
    /// Each subsequent call begins only after the previous public completion is delivered.
    fn next(&mut self) -> Result<(), api::Failure> {
        let (reference, method, payload) = match self.phase {
            0 => (self.project.as_ref().unwrap(), "resolve", json!({})),
            1 | 4 => (
                self.project.as_ref().unwrap(),
                "describe",
                json!({"context":self.context["context"]}),
            ),
            2 => (
                self.analysis.as_ref().unwrap(),
                "request",
                json!({"context":self.context["context"],
                "generation":self.context["generation"],"command":"quickinfo","arguments":{"line":2,"offset":8}}),
            ),
            3 => (
                self.project.as_ref().unwrap(),
                "release",
                json!({"context":self.context["context"]}),
            ),
            _ => return Ok(()),
        };
        self.task = Some(service::guest::Task::start(
            reference,
            method,
            json!({"document":{"path":self.path,"generation":0},"payload":payload.to_string()}),
            30000,
        )?);
        Ok(())
    }
    /// Errors remain structured in the public receipt; only describe after release expects StaleRevision.
    fn advance(&mut self, event: &service::Notification) -> Result<(), api::Failure> {
        let Some(update) = self.task.as_mut().and_then(|task| task.update(event)) else {
            return Ok(());
        };
        let result = match update {
            api::RequestUpdate::Completed { result } => result,
            api::RequestUpdate::Cancelled { reason, .. } => {
                Err(api::Failure::new(reason, "Consumer call cancelled"))
            }
            _ => return Ok(()),
        };
        self.task = None;
        if self.phase == 4 {
            match result {
                Err(error) if error.code == api::ErrorCode::StaleRevision => {
                    self.receipt = Some(
                        json!({"state":"complete","observations":self.observations,"afterRelease":error}),
                    );
                    self.close();
                    return Ok(());
                }
                _ => {
                    return Err(api::Failure::new(
                        api::ErrorCode::InvalidState,
                        "Released context was not rejected",
                    ));
                }
            }
        }
        let value = result?;
        let text = value["payload"].as_str().ok_or_else(|| {
            api::Failure::new(api::ErrorCode::InvalidState, "Missing peer payload")
        })?;
        let payload: Value = serde_json::from_str(text)
            .map_err(|_| api::Failure::new(api::ErrorCode::InvalidState, "Invalid peer payload"))?;
        if self.phase == 0 {
            self.context = payload.clone();
        }
        self.observations.push(payload);
        self.phase += 1;
        self.next()
    }
    /// Explicitly release both public service references on completion, failure or a new command.
    fn close(&mut self) {
        if let Some(task) = self.task.take() {
            let _ = task.cancel(api::CancelMode::StopWaiting);
        }
        for handle in [self.project.take(), self.analysis.take()]
            .into_iter()
            .flatten()
        {
            let _ = api::guest::close_resource(handle);
        }
    }
    /// Publish inert structured observations through the ordinary native panel model.
    fn handle(&mut self, input: api::Input) -> Result<api::Output, api::Failure> {
        if matches!(&input, api::Input::Snapshot) {
            // Observations are test-session receipts, and service handles are never durable state.
            return Ok(api::Output {
                snapshot: Some(plugin_protocol::Snapshot {
                    schema: 1,
                    data: "{}".into(),
                }),
                ..Default::default()
            });
        }
        let result = match input {
            api::Input::Event {
                event: api::Notification::Command { id, arguments, .. },
                ..
            } if id == "run" => self.start(arguments),
            api::Input::Event {
                event: api::Notification::Service(event),
                ..
            } => self.advance(&event),
            _ => Ok(()),
        };
        if let Err(error) = result {
            self.receipt = Some(json!({"state":"failed","phase":self.phase,"error":error}));
            self.close();
        }
        self.revision += 1;
        Ok(api::Output {
            views: vec![api::View {
                panel: "receipt".into(),
                document: ui::Document::new(ui::Node::new(
                    "result",
                    ui::Kind::Text {
                        text: self
                            .receipt
                            .clone()
                            .unwrap_or_else(|| json!({"state":"pending","phase":self.phase}))
                            .to_string(),
                    },
                ))
                .revision(self.revision),
            }],
            ..Default::default()
        })
    }
}
impl Guest for Consumer {
    fn dispatch(payload: String) -> Result<String, String> {
        api::guest::dispatch(&payload, |input| {
            STATE.with(|state| state.borrow_mut().handle(input))
        })
    }
}
export!(Consumer);
