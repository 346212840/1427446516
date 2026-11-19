/* Public Instagram profile, no cookie. A login wall is not a timeline. */

const CODE = /^[A-Za-z0-9_-]{5,40}$/;

function loginWall(data) {
  if (!data || typeof data !== "object") return false;
  if (data.require_login || data.login_required) return true;
  const message = String(data.message || data.status || data.error || "").toLowerCase();
  return message.indexOf("login") >= 0 || message.indexOf("checkpoint") >= 0;
}

function caption(node) {
  const edges = node && node.edge_media_to_caption && node.edge_media_to_caption.edges;
  const text = edges && edges[0] && edges[0].node && edges[0].node.text;
  return String(text || node && node.caption || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function permalink(node) {
  const code = String(node && node.shortcode || "");
  if (!CODE.test(code)) return "";
  const kind = node && (node.product_type === "clips" || node.product_type === "igtv") ? "reel" : "p";
  return "https://www.instagram.com/" + kind + "/" + code + "/";
}

function postsFrom(nodes) {
  const posts = [];
  (nodes || []).forEach((node) => {
    if (!node || posts.length >= 3) return;
    const url = permalink(node);
    if (!url) return;
    const code = url.replace(/\/$/, "").split("/").pop();
    const stamp = Number(node.taken_at_timestamp);
    const date = Number.isFinite(stamp) && stamp > 0 ? new Date(stamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
    posts.push({ id: code, text: caption(node), date, url });
  });
  return posts;
}

export function parseIgProfile(text, spec) {
  const raw = String(text || "");
  const folded = raw.slice(0, 4000).toLowerCase();
  if (!raw || folded.indexOf("httperrorpage") >= 0 || folded.indexOf("accounts/login") >= 0 || folded.indexOf("login_required") >= 0) return null;
  let data = null;
  if (raw.trim().charAt(0) === "{") {
    try { data = JSON.parse(raw); } catch (err) { return null; }
    if (loginWall(data)) return null;
    const user = data && data.data && data.data.user;
    if (!user || typeof user !== "object") return null;
    const edges = user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges;
    const nodes = [];
    (edges || []).forEach((edge) => { if (edge && edge.node) nodes.push(edge.node); });
    return {
      profile: {
        name: String(user.full_name || user.username || spec.handle || "").slice(0, 80),
        avatar: String(user.profile_pic_url_hd || user.profile_pic_url || ""),
        handle: String(user.username || spec.handle || ""),
        url: "https://www.instagram.com/" + String(user.username || spec.handle || "") + "/"
      },
      posts: user.is_private === true ? [] : postsFrom(nodes)
    };
  }
  const match = raw.match(/"contextJSON":"(.*)"\}\]\],\["NavigationMetrics"/);
  if (!match) return null;
  let packed = match[1].replace(/\\\//g, "/").replace(/\\"/g, "\"").replace(/\\n/g, "\n");
  packed = packed.replace(/\\u([0-9A-Fa-f]{4})/g, (all, hex) => String.fromCharCode(parseInt(hex, 16)));
  try { data = JSON.parse(packed); } catch (err) { return null; }
  if (loginWall(data)) return null;
  const rows = data && data.context && data.context.graphql_media;
  const nodes = [];
  (rows || []).forEach((row) => { if (row && row.shortcode_media) nodes.push(row.shortcode_media); });
  return {
    profile: { name: spec.handle || "", avatar: "", handle: spec.handle || "", url: spec.url || "" },
    posts: postsFrom(nodes)
  };
}
