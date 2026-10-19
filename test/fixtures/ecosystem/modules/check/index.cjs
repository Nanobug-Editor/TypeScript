/** Unknown ecosystem semantics: a numeric SFC token must satisfy a contributed string requirement. */
'use strict';
module.exports = () => ({
  version: 2.2,
  resolveEmbeddedCode(_file, sfc, code) {
    if (code.id !== 'script_ts' || !sfc.scriptSetup) return;
    const block = sfc.scriptSetup;
    const offset = block.content.indexOf('42');
    if (offset < 0) return;
    // Actual TypeScript creates diagnostic 2345, with a map back to the editor-owned SFC snapshot.
    code.content.push('\ndeclare function __unknown_check(value: string): void;\n__unknown_check(',
      ['42', block.name, offset, { verification: true }], ');\n');
  },
});
