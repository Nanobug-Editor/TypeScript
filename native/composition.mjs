/** One immutable module composition is validated before starting a candidate TypeScript worker. */
import { createHash } from 'node:crypto';
import { invalid, ProtocolError } from './errors.mjs';
import closure from './module-closure.cjs';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);

/** Canonical inert settings make a composition identity independent of object insertion order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** A declaration binds one host import by its position and export key, never by a guest path.
 * Slots express exclusivity; explicit before/after edges govern order, with stable IDs breaking ties.
 * The engine treats role/ABI names as opaque data; only the primary adapter understands their domain.
 */
export function compose(imports, declarations = [], engineVersion, primaryExport) {
  if (!Array.isArray(imports) || imports.length < 1 || imports.length > 16 || !Array.isArray(declarations)
    || declarations.length !== imports.length - 1) throw invalid('Composition requires one host-issued sealed primary module and each declared contribution');
  for (const descriptor of imports) {
    if (!descriptor || !identifier(descriptor.export_id) || !identifier(descriptor.abi)
      || descriptor.engine?.typescript !== `=${engineVersion}`
      || ![descriptor.package_digest, descriptor.sha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) throw invalid('Incompatible composition ABI or engine seal');
    try { closure.verifyClosure(descriptor); } catch (error) { throw invalid(`Module digest or closure rejected: ${error.message}`); }
  }
  if (imports[0].abi !== 'typescript.adapter/1' || imports[0].export_id !== primaryExport) throw invalid('Incompatible primary adapter ABI');
  const members = new Map();
  for (const [index, declaration] of declarations.entries()) {
    if (!declaration || Object.keys(declaration).some(key => !['id', 'role', 'slot', 'mode', 'abi', 'export', 'config', 'before', 'after'].includes(key))
      || ![declaration.id, declaration.role, declaration.slot, declaration.abi, declaration.export].every(identifier)
      || !['compose', 'exclusive'].includes(declaration.mode) || members.has(declaration.id)
      || !declaration.config || Array.isArray(declaration.config) || typeof declaration.config !== 'object'
      || Buffer.byteLength(JSON.stringify(declaration.config)) > 8192
      || ['before', 'after'].some(key => !Array.isArray(declaration[key]) || declaration[key].length > 15 || declaration[key].some(id => !identifier(id)))) throw invalid('Invalid contribution declaration');
    const descriptor = imports[index + 1];
    if (descriptor.abi !== declaration.abi || descriptor.export_id !== declaration.export) throw invalid('Contribution does not match its sealed import');
    members.set(declaration.id, { ...declaration, descriptor });
  }
  for (const member of members.values()) {
    const peers = [...members.values()].filter(peer => peer.slot === member.slot);
    if (peers.length > 1 && peers.some(peer => peer.mode === 'exclusive')) throw new ProtocolError(-32005, `Exclusive contribution slot conflict: ${member.slot}`);
  }
  const edges = new Map([...members.keys()].map(id => [id, new Set()]));
  for (const member of members.values()) {
    for (const id of [...member.before, ...member.after]) if (!members.has(id) || id === member.id) throw invalid('Unknown or self-referential contribution order');
    for (const id of member.before) edges.get(id).add(member.id);
    for (const id of member.after) edges.get(member.id).add(id);
  }
  const ordered = [];
  while (edges.size) {
    const ready = [...edges.keys()].filter(id => edges.get(id).size === 0).sort();
    if (!ready.length) throw new ProtocolError(-32005, 'Contribution order contains a cycle');
    for (const id of ready) {
      ordered.push(members.get(id)); edges.delete(id);
      for (const dependencies of edges.values()) dependencies.delete(id);
    }
  }
  const adapter = { ...imports[0], contributions: ordered };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(adapter))).digest('hex');
  return { adapter, fingerprint };
}
