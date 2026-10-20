//! Configuration evidence turns worker-local counters into one owner-lifetime registered generation.
use plugin_protocol::{
    api::{ErrorCode, Failure},
    language_context::{self, Descriptor, Reference},
};
use std::collections::BTreeMap;

/// Compiler workers may restart independently; only the business owner assigns monotonic host seals.
#[derive(Default)]
pub(crate) struct Catalog {
    generations: BTreeMap<String, (String, u64)>,
}
impl Catalog {
    /// Atomically register a complete candidate set; failed admission changes no local generation.
    pub(crate) fn register(
        &mut self,
        mut descriptors: Vec<Descriptor>,
    ) -> Result<Vec<Reference>, Failure> {
        let mut next = self.generations.clone();
        for descriptor in &mut descriptors {
            let stamp = descriptor.data["stamp"]
                .as_str()
                .filter(|value| {
                    value.len() == 64
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
                .ok_or_else(|| {
                    Failure::new(
                        ErrorCode::InvalidState,
                        "Missing compiler configuration evidence",
                    )
                })?;
            let generation = match next.get(&descriptor.key) {
                Some((previous, generation)) if previous == stamp => *generation,
                Some((_, generation)) => generation
                    .checked_add(1)
                    .filter(|generation| *generation <= 9_007_199_254_740_991)
                    .ok_or_else(|| {
                        Failure::new(ErrorCode::LimitExceeded, "Project generation exhausted")
                    })?,
                None => 1,
            };
            next.insert(descriptor.key.clone(), (stamp.into(), generation));
            descriptor.generation = generation;
        }
        if next.len() > 128 {
            return Err(Failure::new(
                ErrorCode::LimitExceeded,
                "Project catalog quota exceeded",
            ));
        }
        let references = language_context::register(descriptors)?;
        self.generations = next;
        Ok(references)
    }
}
