// Minimal `util` shim for browser bundles — covers the single
// `util.format` call in generate-function (via is-my-json-valid ->
// near-api-js). printf-style %s/%d/%j/%i/%f/%o/%O substitutions.
export function format(f, ...args) {
  let i = 0
  const str = String(f).replace(/%[sdjifoO]/g, (m) => {
    if (i >= args.length) return m
    const v = args[i++]
    if (m === '%j' || m === '%o' || m === '%O') {
      try { return JSON.stringify(v) } catch (e) { return String(v) }
    }
    if (m === '%d' || m === '%i' || m === '%f') return Number(v)
    return String(v)
  })
  return args.slice(i).reduce((acc, v) => acc + ' ' + String(v), str)
}
export default { format }
