// How the MCP server trims a recall context that is larger than an MCP client's
// tool-result cap. The engine lays a context out as: the manifest scan, then its
// structured sections (event table, fact timeline, anchors, understanding, excerpts),
// and, for a store small enough to fit, a large "complete original content" verbatim
// dump at the very end. Those structured sections are the engine's whole contribution:
// trimming them to keep the tail of a raw dump (what a plain head+tail trim does) defeats
// the point, and because the dump is in date order, keeping its tail drops the oldest
// sessions first. So trim the dump, never the structured sections. When there is no dump
// (a large multi-session store), the relevant material is the retrieved segments at the
// end, so keep the manifest-scan head and the tail.
'use strict';

const DUMP = '# Complete original content';

function capRecallContext(ctx, max) {
  if (!ctx || ctx.length <= max) return ctx;
  const total = ctx.length;
  const d = ctx.indexOf(DUMP);
  if (d >= 0) {
    const structured = ctx.slice(0, d).trimEnd();
    const dump = ctx.slice(d);
    if (structured.length >= max) {
      // Even the structured sections overflow. Keep their head: the manifest scan, the
      // event table and the fact timeline sit here, ahead of the raw dump.
      return structured.slice(0, Math.max(0, max - 120)).trimEnd()
        + `\n[... context truncated (${total} chars total); some structured sections above were cut ...]`;
    }
    const room = max - structured.length - 200;
    if (room <= 0) {
      return structured
        + `\n\n[... complete original content omitted to fit (${total} chars total); the structured sections above are intact ...]`;
    }
    return structured + '\n\n'
      + dump.slice(0, room).trimEnd()
      + `\n[... complete original content trimmed to fit (${total} chars total); the structured sections above are intact ...]`;
  }
  // No verbatim dump: keep the manifest-scan head and the retrieved material at the tail.
  const head = ctx.slice(0, 1500);
  return head
    + `\n[... index scan truncated (${total} chars total; store has grown), most relevant material below ...]\n`
    + ctx.slice(-(max - head.length - 120));
}

module.exports = { capRecallContext, DUMP };
